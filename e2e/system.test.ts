/**
 * Local pre-PR system E2E gate -- Phase 1: container and Compose foundation.
 *
 * See docs/local-e2e-design.md. This file is deliberately NOT under test/, so `npm test` stays
 * Docker-free and CI never runs it. Run it with `npm run test:e2e`.
 *
 * Phase 1 proves the foundation only: the image builds from the current checkout, the API and the
 * worker come up as separate non-root containers that share one volume, only a loopback port is
 * published, nothing dangerous is mounted, and teardown leaves nothing behind. The Run lifecycle
 * journeys arrive in Phase 2.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';
import { COMPOSE_FILE, teardownOutcome, E2E_DIR, LIMITS, capBuffer, composeModel, assertServicesAlive, containerStates, inspectionCommands, keepOnFail, preflight, serviceLogs, verbose } from './preflight.ts';
import { client, pollRun, readSse, TERMINAL, type RunEvent, type RunView } from './helpers.ts';

/**
 * A unique project name per run, so two worktrees or two terminals can run this file at the same
 * time without sharing containers, networks or volumes.
 */
const PROJECT = `mercury-e2e-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Testcontainers keys Compose containers by "<service>-<index>", NOT by service name. Passing
 * "api" does not fail loudly: getContainer throws, and a wait strategy configured under the wrong
 * name is dropped with only a log warning, so the stack would start unwaited-for. The names below
 * are asserted against the running project in before() so a compose major-version change that
 * alters the naming fails here instead of silently weakening the gate.
 */
const SVC = { api: 'api-1', worker: 'worker-1' } as const;

/**
 * The fixture is a one-shot: it exits zero before the API and worker start, and Testcontainers
 * only tracks *running* containers, so it cannot be fetched with getContainer() afterwards. Its
 * readiness is still enforced -- by Wait.forOneShotStartup() during up() and by compose's
 * service_completed_successfully condition -- it is just not inspectable later, so its logs are
 * collected through the compose CLI instead.
 */
const FIXTURE_SERVICE = 'fixture';
const FIXTURE_WAIT_KEY = 'fixture-1';
const DIAG_DIR = `/tmp/${PROJECT}`;

let env: StartedDockerComposeEnvironment | undefined;
let apiBase = '';
let preflightInfo = { node: '', docker: '', compose: '' };
let scenarioError: unknown;
let startupFailed = false;
// Definite assignment rather than a placeholder object. The old initialiser was `{ base: '', token: '' }`
// -- an object with no `get` or `post` -- and needed `as unknown as` to compile at all, which is the sign
// of the problem: the cast existed to silence the compiler noticing the placeholder was not a client.
//
// `!` is a compile-time assertion and nothing more. It does not detect use before `before()` runs; such a
// use would still fail at runtime, on `undefined` instead of on a missing method. The win is only that the
// declaration now states the truth -- these hold a real Client, assigned in `before()` -- so neither a
// lying placeholder nor a double cast is needed to make the file compile.
let alice!: ReturnType<typeof client>;
let bob!: ReturnType<typeof client>;
/** Shared across the sequential journeys: the Run created by the lifecycle test is the one the
 *  owner-scoping test inspects, which is what makes the second test cheap and meaningful. */
let sharedRunId = '';

/** Bound a promise; a teardown that hangs must not hang the suite. */
async function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded HTTP. Every request in this file carries its own deadline. */
async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiBase + path, { ...init, signal: AbortSignal.timeout(LIMITS.requestMs) });
}

/** Run a command inside a service container and return trimmed stdout. */
async function inService(service: 'api' | 'worker', command: string): Promise<string> {
  const res = await env!.getContainer(SVC[service]).exec(['sh', '-c', command]);
  return res.stdout.trim();
}

/**
 * Declare a test whose failure leaves diagnostics behind.
 *
 * node:test does not tell an after() hook whether the suite passed, so the outcome has to be
 * recorded as it happens. Without this the diagnostics path would exist but never run, which is
 * worse than not having it: it would look like failures are investigated.
 */
function guarded(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    try {
      await fn();
    } catch (err) {
      scenarioError = err;
      await withDeadline('diagnostics', LIMITS.diagnosticsMs, collectDiagnostics(name));
      throw err;
    }
  });
}

/**
 * Drain a container log stream with a byte cap and a wall-clock cap.
 *
 * `logs()` on a *running* container is an open stream, not a finite one, so `for await` over it
 * never completes: a naive collector turns every failure diagnosis into a stall that produces no
 * file. Tailing is the whole point, so stop once there is enough and destroy the stream.
 */
async function readBounded(stream: NodeJS.ReadableStream, maxBytes: number, ms: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', done);
      (stream as { destroy?: () => void }).destroy?.();
      resolve();
    };
    const onData = (chunk: Uint8Array) => {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size >= maxBytes) done();
    };
    const timer = setTimeout(done, ms);
    stream.on('data', onData);
    stream.on('end', done);
    stream.on('error', done);
  });
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** Bounded `docker compose logs`, used for the one-shot service that Testcontainers drops. */
async function composeLogs(service: string): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'logs', '--tail', '400', service],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('compose logs timed out')); }, LIMITS.diagnosticsMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

/**
 * On failure, write bounded per-service logs and container state next to a summary, and print the
 * path. A failure that cannot be diagnosed without re-running in verbose mode is a defect in the
 * framework, not in the code under test.
 */
async function collectDiagnostics(reason: string): Promise<void> {
  try {
    mkdirSync(DIAG_DIR, { recursive: true });
    const summary: Record<string, unknown> = { project: PROJECT, reason, at: new Date().toISOString() };
    // Every service goes through the compose CLI, not `container.logs()`. A process that dies during
    // or just after startup is the case where diagnostics matter most and the only case where the
    // Testcontainers handle is unreliable -- it describes what `up()` started, not what is alive now.
    // Routing all three through one path means the dead-service path is the same code that is
    // exercised on every ordinary failure, rather than a rarely-run branch.
    for (const service of [FIXTURE_SERVICE, 'api', 'worker']) {
      try {
        const logs = await serviceLogs(PROJECT, service);
        // Report the bytes that were WRITTEN. The file is capped, so reporting the uncapped length made
        // the summary overstate the artifact exactly when truncation happened -- which is the only time
        // anyone reads this number, because it is the number that tells you the log you want is missing.
        const capped = capBuffer(Buffer.from(logs));
        writeFileSync(join(DIAG_DIR, `${service}.log`), capped);
        summary[service] = {
          collectedVia: 'docker compose logs',
          bytes: capped.byteLength,
          collectedBytes: Buffer.byteLength(logs),
        };
      } catch (err) {
        summary[service] = { error: (err as Error).message };
      }
    }
    try {
      summary.states = await containerStates(PROJECT);
    } catch (err) {
      summary.states = { error: (err as Error).message };
    }
    writeFileSync(join(DIAG_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    console.error(`e2e: diagnostics written to ${DIAG_DIR}`);
  } catch (err) {
    // Diagnostics must never mask the original failure.
    console.error(`e2e: diagnostics collection failed: ${(err as Error).message}`);
  }
}

before(async () => {
  preflightInfo = await preflight();
  if (verbose()) console.error(`e2e: project=${PROJECT} docker=${preflightInfo.docker}`);
  try {
    await bringUp();
  } catch (err) {
    // A failing before() hook makes node:test skip every test in the file, so `guarded()` never runs
    // and the diagnostics path would never execute -- on precisely the failure where a developer most
    // needs it. Collect here, through the compose CLI, which reads the logs of containers that never
    // became ready.
    startupFailed = true;
    await collectDiagnostics('startup failed');
    throw err;
  }
});

async function bringUp(): Promise<void> {
  const started = await new DockerComposeEnvironment(E2E_DIR, 'compose.yml')
    .withBuild()
    .withProjectName(PROJECT)
    .withAutoCleanup(!keepOnFail())
    .withStartupTimeout(LIMITS.startupMs)
    // Pinned, not defaulted. compose.yml reads ${MERCURY_E2E_MOCK_RPC_MODE:-happy}, so an ambient
    // `export MERCURY_E2E_MOCK_RPC_MODE=input` in a developer's shell would otherwise change what the
    // deterministic journey means without saying so -- the suite would still be green while testing
    // something else. The mock-RPC file sets its own value explicitly; this one pins its own.
    .withEnvironment({ MERCURY_E2E_MOCK_RPC_MODE: 'happy' })
    .withWaitStrategy(FIXTURE_WAIT_KEY, Wait.forOneShotStartup())
    .withWaitStrategy(SVC.api, Wait.forHealthCheck())
    // The design calls for plain running-state here. The worker logs "worker started" once its
    // claim loop is live, which costs nothing extra and turns a container that is up but wedged
    // into a startup failure instead of a scenario timeout.
    .withWaitStrategy(SVC.worker, Wait.forLogMessage(/worker started/, 1))
    .up();

  env = started;
  // Before anything touches a handle: `getContainer()` throws "Cannot get container \"api-1\" as it
  // is not running" for a service that died, and node:test repeats that identical line for every test
  // in the file -- eleven failures, none of them containing the reason. A compose healthcheck reports
  // `healthy` from the moment its probe first succeeds, and the wait strategy returns on that first
  // `healthy`, so a process that answers the probe and then dies (here: failing to open its database)
  // lets `up()` resolve over a dead container. This re-check runs first so the reason is in the output.
  try {
    await assertServicesAlive(PROJECT, ['api', 'worker']);
  } catch (err) {
    throw new Error(`a service died during startup; \`up()\` does not prove liveness:\n${(err as Error).message}`);
  }

  // Fail here, with the names that DO exist, rather than from every test separately.
  for (const [service, key] of Object.entries(SVC)) {
    assert.ok(started.getContainer(key), `${service} must be reachable as "${key}"`);
  }
  const api = started.getContainer(SVC.api);
  apiBase = `http://${api.getHost()}:${api.getMappedPort(3000)}`;
  // The tokens are the fixed test identities declared in compose.yml, not secrets.
  alice = client(apiBase, 'tok-alice');
  bob = client(apiBase, 'tok-bob');
}

after(async () => {
  if (!env) return;
  // A startup failure is the one case where the on-disk logs are the ONLY record: no test ran, so
  // there is no assertion output, and the containers are about to be removed. Keep the directory
  // regardless of MERCURY_E2E_KEEP_ON_FAIL and say where it is.
  if (startupFailed) {
    console.error(`e2e: startup failed; diagnostics kept at ${DIAG_DIR}`
      + `\n  ${inspectionCommands(PROJECT, COMPOSE_FILE).join('\n  ')}`);
  }
  if ((scenarioError || startupFailed) && keepOnFail()) {
    console.error(`e2e: FAILED and keeping resources for inspection.\n  diagnostics: ${DIAG_DIR}`
      + `\n  ${inspectionCommands(PROJECT, COMPOSE_FILE).join('\n  ')}`);
    return;
  }
  try {
    await withDeadline('compose teardown', LIMITS.teardownMs, env.down({ removeVolumes: true }));
    if (!startupFailed) rmSync(DIAG_DIR, { recursive: true, force: true });
  } catch (err) {
    // A cleanup problem is reported, but it must not replace the scenario failure that caused it.
    const outcome = teardownOutcome(scenarioError, err as Error);
    console.error(outcome.log);
    if (outcome.propagate) throw err;
  }
});

guarded('preflight reports a usable runtime', () => {
  assert.match(preflightInfo.node, /^\d+\.\d+\.\d+$/);
  assert.ok(preflightInfo.docker.length > 0, 'docker server version should be reported');
  assert.match(preflightInfo.compose, /Compose version v\d+/);
});

guarded('the compose model mounts no host paths and publishes only a loopback port', async () => {
  const model = await composeModel();
  const services = Object.keys(model.services).sort();
  // `verify` joins the topology in Phase 3. It is listed rather than tolerated: this assertion is a
  // deny-by-default check, so a service that appears without being named here fails the gate.
  assert.deepEqual(services, ['api', 'fixture', 'verify', 'worker'], 'unexpected services in the resolved model');

  for (const [name, svc] of Object.entries(model.services)) {
    for (const mount of svc.volumes ?? []) {
      // Compose normalises every bind syntax -- short form, long form, ${'${}'}HOME interpolation,
      // absolute host path -- to type "bind", so this single check covers all of them.
      assert.equal(mount.type, 'volume',
        `${name}: mount ${mount.source} -> ${mount.target} is a ${mount.type} mount; the stack must`
        + ' reach the checkout only through the image, never the host filesystem');
      assert.ok(mount.source && model.volumes && mount.source in model.volumes,
        `${name}: mount source "${mount.source}" is not a named volume declared in this file`);
      assert.ok(!String(mount.source).includes('docker.sock'),
        `${name}: must not reach the host Docker daemon`);
    }
    assert.notEqual(svc.user, '0', `${name} must not be pinned to container root`);
  }

  const publishing = Object.entries(model.services).filter(([, svc]) => (svc.ports ?? []).length > 0);
  assert.deepEqual(publishing.map(([name]) => name), ['api'],
    'only the API may publish a port; a published worker port would need no test at all');
  for (const [name, svc] of publishing) {
    for (const port of svc.ports ?? []) {
      assert.equal(port.host_ip, '127.0.0.1',
        `${name}: published port ${port.target} binds to "${port.host_ip ?? 'all interfaces'}"`);
      assert.equal(port.published, undefined,
        `${name}: port ${port.target} pins host port ${port.published}; it must be random so two`
        + ' runs and a developer running Mercury locally cannot collide');
    }
  }
});

guarded('the API answers on its mapped loopback port', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; product?: string; version?: string };
  assert.equal(body.ok, true);
  const pkg = JSON.parse(await readFile(join(E2E_DIR, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(body.version, pkg.version, 'the container must run the checkout under test');
  assert.ok(body.product, 'product must be reported');
});

guarded('API and worker are separate non-root processes', async () => {
  const apiId = env!.getContainer(SVC.api).getId();
  const workerId = env!.getContainer(SVC.worker).getId();
  assert.notEqual(apiId, workerId, 'the gate is meaningless if both roles share one container');

  for (const service of ['api', 'worker'] as const) {
    const uid = await inService(service, 'id -u');
    assert.notEqual(uid, '0', `${service} must not run as container root`);
  }
});

guarded('API and worker share one state volume at one path', async () => {
  const [apiDev, workerDev] = await Promise.all([
    inService('api', 'findmnt -n -o SOURCE /state'),
    inService('worker', 'findmnt -n -o SOURCE /state'),
  ]);
  assert.match(apiDev, /mercury-e2e-state/, 'API /state must be the named volume');
  assert.equal(apiDev, workerDev, 'both processes must see the same volume, or the gate proves nothing');

  // The same absolute path in both is what keeps persisted workspace paths and git worktree
  // metadata valid from either process.
  const apiState = await inService('api', 'ls /state');
  assert.match(apiState, /fixture-repo/, 'the fixture repository must be on the shared volume');
});

guarded('no Docker socket and no host source mount inside the services', async () => {
  for (const service of ['api', 'worker'] as const) {
    const sock = await inService(service, 'test -e /var/run/docker.sock && echo PRESENT || echo ABSENT');
    assert.equal(sock, 'ABSENT', `${service} must not reach the host Docker daemon`);

    // The checkout is copied into the image, not mounted: a mock agent must not be able to edit
    // the developer's files, and a macOS path must not leak into a Linux container.
    const mounts = await inService(service, 'grep -c " /app " /proc/self/mountinfo || true');
    assert.equal(mounts, '0', `${service} /app must be image content, not a bind mount`);
  }
});

guarded('the worker is actually consuming the queue the API writes to', async () => {
  // Not a Run scenario -- that is Phase 2. This only proves the two containers are wired to the
  // same database well enough for the worker to have opened it, which is the foundation claim.
  const db = await inService('worker', 'test -f /state/mercury.db && echo PRESENT || echo ABSENT');
  assert.equal(db, 'PRESENT', 'the worker must open the database the API created');
  const journal = await inService('worker', 'test -f /state/mercury.db-wal && echo PRESENT || echo ABSENT');
  assert.equal(journal, 'PRESENT', 'the shared database must be in WAL mode');
});

/**
 * Phase 2 -- the fake-agent system journey.
 *
 * This is the shape nothing else in the repository covers: an external client submitting a Run over
 * public HTTP, watching it through SSE, and seeing a *separate* process claim it, build a real git
 * worktree, run an agent and write the result back through the same SQLite file.
 *
 * ORDERING MATTERS. These scenarios run sequentially against one stack, by design: the design
 * rejects parallel scenarios because they would share a queue, a worker and a fixture repository
 * and make failures impossible to attribute. Two couplings depend on declaration order:
 *
 *   - owner scoping inspects the Run the lifecycle scenario created, via `sharedRunId`. If the
 *     lifecycle scenario fails first, owner scoping fails with its own explicit message rather than
 *     a confusing one.
 *   - the worker-absent scenario STOPS a container, so it must stay last.
 *
 * node:test runs tests in declaration order within a file; moving a scenario is a behavioural
 * change, not a cosmetic one.
 */
guarded('a fake Run completes across separate API and worker containers', async () => {
  const created = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    {
      task: 'E2E plumbing run',
      agent: 'fake',
      // A path the *worker container* resolves, not the host. Sharing /state at the same absolute
      // path in both processes is what makes this legal from the API and real from the worker.
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' },
    },
    'create run',
  );
  assert.equal(created.status, 201);
  sharedRunId = created.body.runId;
  assert.ok(sharedRunId, 'a runId must be returned');
  assert.equal(created.body.status, 'QUEUED');

  // SSE first: the fake agent can finish before a REST poller ever looks, so the durable event
  // stream -- not a sequence of status snapshots -- is what proves the intermediate lifecycle.
  const stream = await readSse(apiBase, 'tok-alice', sharedRunId, 60_000);
  const types = stream.events.map((e) => e.type);
  for (const required of ['run.created', 'run.started', 'run.completed']) {
    assert.ok(types.includes(required), `stream is missing ${required}; saw ${types.join(', ')}`);
  }

  const seqs = stream.events.map((e) => e.sequence);
  assert.ok(seqs.length > 0, 'the stream delivered no events');
  assert.equal(seqs[0], 1, `the first event must be sequence 1, not ${seqs[0]}`);
  assert.equal(new Set(seqs).size, seqs.length, 'event sequences must be unique');
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'event sequences must strictly increase');

  const final = await pollRun(alice, sharedRunId, (r) => TERMINAL.has(r.status), 'a terminal state', 60_000);
  assert.equal(final.status, 'COMPLETED', `run ended ${final.status}: ${final.error ?? ''}`);

  // The SSE terminal event and the authoritative REST state have to agree.
  const lastStreamed = stream.events[stream.events.length - 1];
  assert.equal(lastStreamed.type, 'run.completed');

  const page = await alice.get<{ events: RunEvent[] }>(`/api/runs/${sharedRunId}/events`, 'run events');
  const restTypes = page.events.map((e) => e.type);
  assert.ok(restTypes.includes('run.completed'), 'the terminal event must be persisted, not only streamed');
  assert.ok(!restTypes.some((t) => t.includes('failed') || t.includes('error')),
    `no failure event expected: ${restTypes.join(', ')}`);

  // Real git-worktree isolation, asserted from the paths the worker actually produced.
  assert.ok(final.workspacePath?.startsWith('/state/workspaces/worktrees/'),
    `workspace must be a worktree under /state: ${final.workspacePath}`);
  assert.equal(final.workspaceBranch, `agent/${sharedRunId}`);

  // The path alone does not prove worktree mode: Mercury puts *copies* under worktrees/ too, so the
  // assertion above passes in either mode. What distinguishes them is on disk -- `git worktree add`
  // leaves a .git FILE pointing into the shared clone, while a copy leaves a .git DIRECTORY. Without
  // this the gate would keep claiming it exercises the git-worktree path after someone switched it
  // to copy mode.
  const gitKind = await inService('worker', `test -f ${final.workspacePath}/.git && echo FILE || (test -d ${final.workspacePath}/.git && echo DIR || echo MISSING)`);
  assert.equal(gitKind, 'FILE',
    'the workspace must be a real git worktree (.git file), not a copied repository');

  // The gitdir has to resolve on the shared volume. This is the concrete form of the design's
  // "same absolute path in every container" rule: a worktree whose admin directory lives outside
  // /state would be unreadable from the other process, and a macOS-side path would be nonsense
  // here. Mercury worktrees straight off the primary repository, so this points into the fixture.
  const gitdir = await inService('worker', `cat ${final.workspacePath}/.git`);
  assert.match(gitdir, /^gitdir: \/state\//,
    `the worktree admin dir must live on the shared volume: ${gitdir}`);

  // The Run stays retrievable after the stream is gone.
  const again = await alice.get<{ run: RunView }>(`/api/runs/${sharedRunId}`, 're-fetch run');
  assert.equal(again.run.status, 'COMPLETED');
});

guarded('owner scoping survives the production-shaped configuration', async () => {
  assert.ok(sharedRunId, 'the owner-scoping journey needs the Run from the previous scenario');

  await alice.get<{ run: RunView }>(`/api/runs/${sharedRunId}`, 'alice reads her run');

  // 404, not 403: another owner's Run must not be distinguishable from one that does not exist.
  await assert.rejects(() => bob.get(`/api/runs/${sharedRunId}`, 'bob reads alice run'),
    (err: unknown) => (err as { status?: number }).status === 404);
  await assert.rejects(() => bob.get(`/api/runs/${sharedRunId}/events`, 'bob reads alice events'),
    (err: unknown) => (err as { status?: number }).status === 404);
});

guarded('unauthenticated requests are refused on the API surface', async () => {
  const anon = client(apiBase, '');
  await assert.rejects(() => anon.get('/api/agents', 'anonymous agents'),
    (err: unknown) => (err as { status?: number }).status === 401);
});

/**
 * The gate has to be *loud* when the worker is missing.
 *
 * A Run that never leaves QUEUED is the most likely way this stack breaks in practice -- a bad
 * adapter config, a worker that cannot reach the volume -- and a bare "timed out" sends the
 * developer to read four log files. So this stops the worker on purpose and asserts the failure
 * names the last observed status and points at the logs.
 *
 * It runs last: stopping a container is destructive to the shared stack, and teardown follows.
 */
// --- Phase 0 contracts, seen from outside the process -------------------------------------------
//
// Each Phase 0 fix was proven by a unit test, and a unit test proves the code does what the author
// believed about the code. These four assert the same fixes through the production shape: public HTTP,
// a separate worker process, and the container filesystem an operator actually deploys. Two of them
// (#506, #510) are only observable across a process boundary at all.

guarded('the health endpoint advertises the API schema version (#510)', async () => {
  // Fleet refuses to register a host whose schema it cannot speak. That negotiation is worthless if
  // the number is absent, and worthless if it is a string a client has to guess the meaning of.
  const res = await fetch(`${apiBase}/healthz`, { signal: AbortSignal.timeout(LIMITS.requestMs) });
  assert.equal(res.status, 200, '/healthz must answer without a token');
  const health = await res.json() as { ok: boolean; product: string; version: string; api?: unknown };
  // A real typeof check rather than assert.equal(typeof ...): TS does not narrow `unknown` through an
  // assertion, and a guard that cannot narrow is a guard the next edit will cast away.
  if (typeof health.api !== 'number') {
    throw new Error(`/healthz api must be a number, got ${JSON.stringify(health.api)}`);
  }
  assert.ok(Number.isInteger(health.api) && health.api >= 1,
    `api schema version must be a positive integer, got ${health.api}`);
  // Absent is not zero. A host that predates the field reports nothing; a host reporting 0 would be
  // removed from rotation, turning a compatibility check into an outage.
  assert.notEqual(health.api, 0, 'api must never be 0; absent and incompatible are different facts');
});

guarded('every advertised agent declares how it receives skills (#508)', async () => {
  // The value that decides behaviour is `static.skills`: workspace paths or native names. A caller
  // choosing a skill namespace from this response must never receive `undefined` and silently fall
  // back to a guess -- that silent-default is what made Hermes unusable for months.
  //
  // `capabilities` is a PARALLEL map keyed by agent id, and `agents` stays a plain string[]. That is
  // deliberate: the dashboard does `if (!Array.isArray(agents)) return;`, so reshaping `agents` into
  // objects would make it silently discard every server-registered agent and render two hardcoded
  // ones -- a working server showing a shorter list, with no error anywhere.
  //
  // Scope, stated precisely: this asserts the SERVER half. It catches `agents` being reshaped into
  // objects, which is the change that would silently empty the dropdown. It does NOT exercise the
  // dashboard, so it cannot prove ui/index.js still renders -- that guard lives in the dashboard's own
  // defensive check, and a dashboard-side regression needs the Playwright tier (docs/local-e2e-design.md
  // Phase 8, not built). A test that reads only the capabilities map would not notice the array being
  // broken, which is why the array is asserted at all.
  const res = await alice.get<{
    agents: unknown;
    defaultAgent: string;
    capabilities?: Record<string, { static?: { skills?: string } }>;
  }>('/api/agents', 'agents');
  assert.ok(Array.isArray(res.agents),
    '`agents` must stay a string[]; reshaping it makes the dashboard silently drop every real agent');
  const ids = res.agents as string[];
  assert.ok(ids.length > 0, 'the stack must advertise at least one agent');
  assert.ok(res.capabilities, 'capabilities must be present; an absent map reads as "no agent supports goals"');

  const modes = new Set(['workspacePaths', 'nativeNames', 'none']);
  for (const id of ids) {
    const caps = res.capabilities[id];
    assert.ok(caps, `${id}: advertised but absent from the capabilities map`);
    assert.ok(caps.static && typeof caps.static === 'object',
      `${id}: no static capability block; a caller cannot tell how it receives skills`);
    assert.ok(modes.has(caps.static.skills ?? ''),
      `${id}: skills="${caps.static.skills}" is not one of ${[...modes].join(' | ')}`);
  }
  // The stack's default agent is `fake`, which executes nothing and therefore receives nothing.
  assert.equal(res.defaultAgent, 'fake', 'compose sets MERCURY_DEFAULT_AGENT=fake');
  assert.equal(res.capabilities.fake.static?.skills, 'none',
    'fake executes nothing, so it must not claim a delivery mode');
});

guarded('an explicit empty skills list yields a zero-skill Run that still completes (#507)', async () => {
  // `skills: []` means "no skills"; an omitted `skills` means "choose for me". Collapsing them made
  // every Run carry at least one Mercury skill id, which a backend resolving names in its own store
  // rejects fatally. The distinction has to survive the HTTP body, the queue, and a second process.
  const created = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    { task: 'E2E zero-skill run', agent: 'fake', skills: [],
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' } },
    'create zero-skill run',
  );
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const runId = created.body.runId;
  const view = await pollRun(alice, runId, (r) => r.status === 'COMPLETED', 'a completed zero-skill Run', 90_000);
  assert.equal(view.status, 'COMPLETED', `zero-skill run did not complete: ${JSON.stringify(view)}`);

  const detail = await alice.get<{ run: { id: string }; skills: Array<{ id: string }> }>(
    `/api/runs/${runId}`, 'zero-skill detail');
  assert.deepEqual(detail.skills, [],
    `skills:[] was coerced into an automatic selection: ${JSON.stringify(detail.skills.map((s) => s.id))}`);
});

guarded('a Run still executes its stored skill snapshot after the skill vanishes from the worker (#506)', async () => {
  // The strongest of the four, and the only one that needs two filesystems.
  //
  // The worker used to re-resolve the Run's skill ids against the LIVE registry at claim time. Delete
  // or rename one skill and every queued Run naming it died with "Skill not found" -- and could not be
  // retried, because retry re-resolved too. The fix makes the worker execute the snapshot persisted at
  // create time. That is a cross-process claim: it can only be observed by changing one container's
  // filesystem and letting the other one submit.
  //
  // Deleting BEFORE creating removes any race with the claim loop. The API container still has the
  // skill, so create() snapshots it normally; the worker container does not, so a worker that still
  // consulted its own registry would fail exactly as production did.
  const skillId = 'testing';
  const skillDir = `/app/.agents/skills/${skillId}`;
  const before = await inService('worker', `test -d ${skillDir} && echo present || echo absent`);
  assert.equal(before, 'present', `expected ${skillDir} in the worker image before deleting it`);
  await inService('worker', `rm -rf ${skillDir}`);
  const after = await inService('worker', `test -d ${skillDir} && echo present || echo absent`);
  assert.equal(after, 'absent', `could not remove ${skillDir}; the scenario would prove nothing`);

  const created = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    { task: 'E2E snapshot run', agent: 'fake', skills: [skillId],
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' } },
    'create snapshot run',
  );
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const runId = created.body.runId;

  // The snapshot is durable at create time: id, version and content hash, not just a name to look up.
  const detail = await alice.get<{ run: { id: string }; skills: Array<{ id: string; version?: string; hash?: string }> }>(
    `/api/runs/${runId}`, 'snapshot detail');
  assert.deepEqual(detail.skills.map((s) => s.id), [skillId], 'the Run must carry exactly the named skill');
  assert.ok(detail.skills[0].hash, 'the stored skill record must carry a content hash');

  const view = await pollRun(alice, runId, (r) => TERMINAL.has(r.status), 'a terminal state', 90_000);
  assert.equal(view.status, 'COMPLETED',
    `the worker re-resolved against its own registry instead of the snapshot: ${JSON.stringify(view)}`);
});

guarded('the gate fails clearly when no worker is consuming the queue', async () => {
  // Stop the worker BEFORE submitting. Stopping after submission let the claim loop pick the Run up
  // first, so it reached STARTING and the scenario tested a different interleaving than it claimed.
  await env!.getContainer(SVC.worker).stop({ timeout: 5 });

  const created = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    { task: 'orphaned run', agent: 'fake', repository: { localPath: '/state/fixture-repo', baseBranch: 'main' } },
    'create orphan run',
  );
  const orphanId = created.body.runId;

  const startedAt = Date.now();
  await assert.rejects(
    () => pollRun(alice, orphanId, (r) => TERMINAL.has(r.status), 'a terminal state', 8_000),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, new RegExp(orphanId), 'the failure must name the Run');
      // Assert the property, not one specific status: the message has to say what was last seen.
      const seen = /last observed status=([A-Z_]+)/.exec(message);
      assert.ok(seen, `the failure must report the last observed status: ${message}`);
      assert.ok(!TERMINAL.has(seen![1]), `reported status ${seen![1]} should not have timed out`);
      assert.match(message, /worker\.log/, `the failure must point at the logs: ${message}`);
      return true;
    },
  );
  // And it must give up on its deadline rather than hang.
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 8_000 && elapsed < 30_000, `the poll must honour its 8s deadline, took ${elapsed}ms`);
});
