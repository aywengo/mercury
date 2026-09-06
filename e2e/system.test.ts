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
import { COMPOSE_FILE, E2E_DIR, LIMITS, composeModel, keepOnFail, preflight, verbose } from './preflight.ts';

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
let scenarioFailed = false;

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
      scenarioFailed = true;
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
    // Concurrent: each service read is capped at 5s, and doing them in series would double the
    // delay between a failure and the developer seeing why.
    await Promise.all(['api', 'worker'].map(async (service) => {
      const key = service as 'api' | 'worker';
      try {
        const container = env!.getContainer(SVC[key]);
        const stream = await container.logs({ tail: 400 });
        writeFileSync(join(DIAG_DIR, `${service}.log`), await readBounded(stream, 1_000_000, 5_000));
        summary[service] = { id: container.getId(), name: container.getName() };
      } catch (err) {
        summary[service] = { error: (err as Error).message };
      }
    }));

    // The one-shot has exited and is no longer tracked, so its output comes from compose itself.
    try {
      const logs = await composeLogs(FIXTURE_SERVICE);
      writeFileSync(join(DIAG_DIR, `${FIXTURE_SERVICE}.log`), logs.subarray(0, 1_000_000));
      summary[FIXTURE_SERVICE] = { collectedVia: 'docker compose logs', bytes: logs.length };
    } catch (err) {
      summary[FIXTURE_SERVICE] = { error: (err as Error).message };
    }
    writeFileSync(join(DIAG_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  } catch (err) {
    // Diagnostics must never mask the original failure.
    console.error(`e2e: diagnostics collection failed: ${(err as Error).message}`);
  }
}

before(async () => {
  preflightInfo = await preflight();
  if (verbose()) console.error(`e2e: project=${PROJECT} docker=${preflightInfo.docker}`);

  const started = await new DockerComposeEnvironment(E2E_DIR, 'compose.yml')
    .withBuild()
    .withProjectName(PROJECT)
    .withAutoCleanup(!keepOnFail())
    .withStartupTimeout(LIMITS.startupMs)
    .withWaitStrategy(FIXTURE_WAIT_KEY, Wait.forOneShotStartup())
    .withWaitStrategy(SVC.api, Wait.forHealthCheck())
    // The design calls for plain running-state here. The worker logs "worker started" once its
    // claim loop is live, which costs nothing extra and turns a container that is up but wedged
    // into a startup failure instead of a scenario timeout.
    .withWaitStrategy(SVC.worker, Wait.forLogMessage(/worker started/, 1))
    .up();

  env = started;
  // Fail here, with the names that DO exist, rather than from every test separately.
  for (const [service, key] of Object.entries(SVC)) {
    assert.ok(started.getContainer(key), `${service} must be reachable as "${key}"`);
  }
  const api = started.getContainer(SVC.api);
  apiBase = `http://${api.getHost()}:${api.getMappedPort(3000)}`;
});

after(async () => {
  if (!env) return;
  if (scenarioFailed && keepOnFail()) {
    console.error(`e2e: FAILED and keeping resources for inspection.\n  diagnostics: ${DIAG_DIR}`
      + `\n  cleanup:     docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v`);
    return;
  }
  try {
    await withDeadline('compose teardown', LIMITS.teardownMs, env.down({ removeVolumes: true }));
    rmSync(DIAG_DIR, { recursive: true, force: true });
  } catch (err) {
    // A cleanup problem is reported, but it must not replace the scenario failure that caused it.
    console.error(`e2e: teardown reported a problem: ${(err as Error).message}`);
    if (!scenarioFailed) throw err;
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
  assert.deepEqual(services, ['api', 'fixture', 'worker'], 'unexpected services in the resolved model');

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
