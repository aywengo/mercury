/**
 * A6-3 (#691): the containerized knowledge scenario (docs/knowledge-base.md section 11.6).
 *
 * "Two hosts, one Atlas, one project, and a note learned on host A materialized on host B."
 *
 * The in-process version of this claim is test/knowledgeTeachE2E.test.ts. This file repeats the
 * journey through the production shape, where nothing is shared but the Atlas SERVICE: two full
 * Mercury stacks on separate named volumes -- separate SQLite, separate workspaces, separate
 * contributor identities -- plus one Atlas container reached over HTTPS with a CA the hosts
 * validate through MERCURY_ATLAS_CA_FILE.
 *
 * The topology lives in compose.yml under `profiles: [knowledge]`, so the default gate and the
 * mock-RPC journey resolve exactly the four services they always had: `docker compose config`
 * omits profiled services, which is what keeps system.test.ts's deny-by-default list honest
 * without changing it. Host A is the shared api/worker pair -- its Atlas env comes from the
 * MERCURY_E2E_* interpolation, which defaults to EMPTY, i.e. the one disabled state. This file
 * pins those variables for its own stack only.
 *
 * The lesson originates in the TEST, as the Run's task text, over the public API. The note-writer
 * agent (e2e/local-agents/note-writer.json) writes that task into the workspace's tier-1 note file
 * and nothing else; no lesson string is baked into any committed file.
 *
 * Run with `npm run test:e2e` (collected with the rest of e2e/). Needs the Docker daemon.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';
import { COMPOSE_FILE, E2E_DIR, LIMITS, capBuffer, composeModel, containerStates, deadServices, inspectionCommands, keepOnFail, preflight, serviceLogs, teardownOutcome, verbose } from './preflight.ts';
import { client, pollRun, TERMINAL, type RunView } from './helpers.ts';

/** Unique per run, so parallel runs of this file never share containers, networks or volumes. */
const PROJECT = `mercury-e2e-knowledge-${Math.random().toString(36).slice(2, 10)}`;

/** Compose atlas project: the one project both hosts contribute to and read from. */
const ATLAS_PROJECT = 'e2e-bridge';

/**
 * Fixed test identities, exactly like tok-alice in compose.yml: contributor tokens are seeded by
 * init-atlas from these values and bind hostId on the Atlas side. The admin token is pinned in
 * compose.yml (ATLAS_ADMIN_TOKEN) and used for the promotion act only.
 */
const TOKEN_A = 'e2e-contrib-a-0123456789ab';
const TOKEN_B = 'e2e-contrib-b-0123456789ab';
const ADMIN = 'atlas-admin-token-local';

/** The lessons. Each exists nowhere in the repository except in the test that travels it. */
const LESSON_A = 'KILNROOT-4c7a92: verify the release artefact with glimmer-check --sigil=KILNROOT-4c7a92';
const LESSON_B = 'KILNROOT-9d31be: rotate the staging credential before the dry run';

/**
 * Testcontainers keys Compose containers by "<service>-<index>". Host A is the shared api/worker
 * pair, so its keys match system.test.ts; the profiled topology adds the rest.
 */
const SVC = {
  api: 'api-1',
  worker: 'worker-1',
  atlas: 'atlas-1',
  apiB: 'api-b-1',
  workerB: 'worker-b-1',
  initAtlas: 'init-atlas-1',
} as const;

const DIAG_DIR = `/tmp/${PROJECT}`;

let env: StartedDockerComposeEnvironment | undefined;
let apiBase = '';
let apiBBase = '';
let preflightInfo = { node: '', docker: '', compose: '' };
let scenarioError: unknown;
let startupFailed = false;
let alice!: ReturnType<typeof client>;
let bob!: ReturnType<typeof client>;

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

/** Run a shell command inside a service container and return trimmed stdout. */
async function inService(key: keyof typeof SVC, command: string): Promise<string> {
  const res = await env!.getContainer(SVC[key]).exec(['sh', '-c', command]);
  if (res.exitCode !== 0) {
    throw new Error(`${key}: exit ${res.exitCode} for: ${command}\n${res.stderr || res.stdout}`.slice(0, 800));
  }
  return res.stdout.trim();
}

/**
 * Run `node -e <script>` in a container as ARGV, not through a shell. The scripts embed JSON and
 * SQL with both quote flavors; any quoting layer between them is a bug generator, so there is none.
 */
async function execNode(key: keyof typeof SVC, script: string): Promise<string> {
  const res = await env!.getContainer(SVC[key]).exec(['node', '-e', script]);
  if (res.exitCode !== 0) {
    throw new Error(`${key}: node -e exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 600)}`);
  }
  return res.stdout.trim();
}

/**
 * Bounded `docker compose` call for lifecycle acts the handles cannot do safely.
 *
 * Testcontainers' `stop()` on a compose container stops AND REMOVES it, which is fatal for the
 * K4 leg: the scenario must restart the same service afterwards. The compose CLI stops and starts
 * in place, which is also exactly what an operator would type.
 */
async function compose(args: string[]): Promise<string> {
  const { spawn: sp } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = sp('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args],
      { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`docker compose ${args.join(' ')} timed out`)); },
      LIMITS.diagnosticsMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { out += chunk; });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`docker compose ${args.join(' ')} exited ${code}: ${out.slice(-400)}`));
      else resolve(out);
    });
  });
}

/** Bounded `docker compose logs` for one-shot services Testcontainers drops. */
async function composeLogs(service: string): Promise<Buffer> {
  const { spawn: sp } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = sp('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'logs', '--tail', '400', service],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('compose logs timed out')); }, LIMITS.diagnosticsMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

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
 * On failure: bounded per-service logs, container states, and a summary. Same contract as
 * system.test.ts; the one-shot init-atlas is collected through the compose CLI because
 * Testcontainers cannot hold a handle on an exited container.
 */
async function collectDiagnostics(reason: string): Promise<void> {
  try {
    mkdirSync(DIAG_DIR, { recursive: true });
    const summary: Record<string, unknown> = { project: PROJECT, reason, at: new Date().toISOString() };
    const serviceNames: Record<string, string> = {
      initAtlas: 'init-atlas', api: 'api', worker: 'worker',
      atlas: 'atlas', apiB: 'api-b', workerB: 'worker-b',
    };
    for (const [name, service] of Object.entries(serviceNames)) {
      try {
        // The one-shot is invisible to Testcontainers' handles once it exits; the compose CLI reads
        // its log file either way -- the same path system.test.ts uses for `fixture`.
        const logs = name === 'initAtlas'
          ? await composeLogs(service)
          : Buffer.from(await serviceLogs(PROJECT, service));
        const capped = capBuffer(logs);
        writeFileSync(join(DIAG_DIR, `${name}.log`), capped);
        summary[name] = { bytes: capped.byteLength };
      } catch (err) {
        summary[name] = { error: (err as Error).message };
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
    console.error(`e2e: diagnostics collection failed: ${(err as Error).message}`);
  }
}

/**
 * Atlas talks HTTPS with the self-signed CA generated in init-atlas; the CA file is on the atlas
 * volume, mounted read-only into every Mercury container at /atlas-state/ca.pem. Admin and
 * contributor acts therefore run INSIDE a container, over the same verified-TLS path the hosts
 * themselves use -- the test never disables certificate verification anywhere.
 *
 * The script is a string so it can carry the per-call token/method/body; `node -e` keeps it off
 * disk. Output is JSON on one line.
 */
function atlasFetchScript(method: string, path: string, token: string, body: unknown): string {
  return `
    const https = require('node:https');
    const { readFileSync } = require('node:fs');
    const req = https.request({
      host: 'atlas', port: 4100, path: ${JSON.stringify(path)}, method: ${JSON.stringify(method)},
      headers: {
        authorization: 'Bearer ' + ${JSON.stringify(token)},
        'content-type': 'application/json',
      },
      ca: readFileSync('/atlas-state/ca.pem'),
      servername: 'atlas',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        process.stdout.write(JSON.stringify({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
    });
    req.on('error', (e) => { process.stdout.write(JSON.stringify({ status: 0, body: String(e) })); });
    req.end(${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))});
  `;
}

async function atlasFetch(key: keyof typeof SVC, method: string, path: string, token: string, body?: unknown):
  Promise<{ status: number; body: string }> {
  const out = await execNode(key, atlasFetchScript(method, path, token, body));
  const parsed = JSON.parse(out) as { status: number; body: string };
  return parsed;
}

/**
 * POSIX single-quote wrapper for the few shell paths left (grep patterns). The embedded scripts
 * DO contain single quotes -- SQL literals like `tier = 'promoted'` -- which is exactly what this
 * escaping exists to carry. Scripts that can hold such payloads normally go through execNode's
 * argv form instead, where no quoting layer exists at all.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Read-only SQL against a host's SQLite from outside the process, through node:sqlite with
 * readOnly: true. The e2e contract keeps Mercury internals out of the test process; asking the
 * CONTAINER what its own database says is operator-shaped -- the same question `sqlite3 file` is.
 */
function countScript(dbPath: string, sql: string): string {
  return `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
    process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(sql)}).get()));
    db.close();
  `;
}

async function pollExec(key: keyof typeof SVC, what: string, deadlineMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError = '';
  for (;;) {
    try {
      if (await probe()) return;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what} did not happen within ${deadlineMs}ms${lastError ? `; last error: ${lastError}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  preflightInfo = await preflight();
  if (verbose()) console.error(`e2e: project=${PROJECT} docker=${preflightInfo.docker}`);
  try {
    await bringUp();
  } catch (err) {
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
    // The knowledge profile turns on the Atlas topology; the MERCURY_E2E_* pins are what the
    // compose file interpolates into host A's knowledge env. Empty defaults in compose.yml keep
    // every OTHER stack (system, mock-rpc) in the disabled state -- the same one-var mechanism
    // the mock-RPC journey uses for MOCK_RPC_MODE.
    .withProfiles('knowledge')
    .withEnvironment({
      MERCURY_E2E_MOCK_RPC_MODE: 'happy',
      MERCURY_E2E_ATLAS_URL: 'https://atlas:4100',
      MERCURY_E2E_ATLAS_PROJECT: ATLAS_PROJECT,
      MERCURY_E2E_TOKEN_A: TOKEN_A,
      MERCURY_E2E_TOKEN_B: TOKEN_B,
      MERCURY_E2E_HOST_A: 'host-a',
      MERCURY_E2E_HOST_B: 'host-b',
      MERCURY_E2E_KNOWLEDGE_PUSH_MS: '1000',
      MERCURY_E2E_KNOWLEDGE_PULL_MS: '1000',
    })
    .withWaitStrategy(SVC.initAtlas, Wait.forOneShotStartup())
    .withWaitStrategy(SVC.atlas, Wait.forHealthCheck())
    .withWaitStrategy(SVC.api, Wait.forHealthCheck())
    .withWaitStrategy(SVC.worker, Wait.forLogMessage(/worker started/, 1))
    .withWaitStrategy(SVC.apiB, Wait.forHealthCheck())
    .withWaitStrategy(SVC.workerB, Wait.forLogMessage(/worker started/, 1))
    // Named services rather than the whole file: the knowledge stack does not need `verify`
    // (a one-shot that runs the full npm suite in the image — pure CPU contention next to the
    // scenarios). Compose still honours depends_on for everything named.
    .up(['fixture', 'api', 'worker', 'atlas', 'api-b', 'worker-b']);

  env = started;
  try {
    await assertServicesAlive();
  } catch (err) {
    throw new Error(`a service died during startup; \`up()\` does not prove liveness:\n${(err as Error).message}`);
  }

  const api = started.getContainer(SVC.api);
  apiBase = `http://${api.getHost()}:${api.getMappedPort(3000)}`;
  const apiB = started.getContainer(SVC.apiB);
  apiBBase = `http://${apiB.getHost()}:${apiB.getMappedPort(3000)}`;
  alice = client(apiBase, 'tok-alice');
  bob = client(apiBBase, 'tok-alice');
}

/** A service that answered its wait strategy and then died must fail startup, not the scenario. */
async function assertServicesAlive(): Promise<void> {
  const states = await containerStates(PROJECT);
  const dead = deadServices(states, PROJECT, ['atlas', 'api', 'worker', 'api-b', 'worker-b']);
  assert.deepEqual(dead, [], 'every long-running service must still be alive after up()');
}

after(async () => {
  if (!env) return;
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
    const outcome = teardownOutcome(scenarioError, err as Error);
    console.error(outcome.log);
    if (outcome.propagate) throw err;
  }
});

guarded('the knowledge topology resolves with the profile and both hosts point at Atlas', async () => {
  // The default model must NOT contain the profiled services: this is what keeps the other stacks
  // byte-identical (system.test.ts pins the four-service default list independently).
  const model = await composeModel();
  assert.ok(!('atlas' in model.services), 'the default compose model must not resolve the knowledge profile');
  assert.ok(!('api-b' in model.services), 'the default compose model must not resolve host B');

  // Host A is wired for Atlas over verified TLS from the pinned interpolation.
  const atlasUrl = await inService('worker', 'echo $MERCURY_ATLAS_URL');
  assert.equal(atlasUrl, 'https://atlas:4100', 'host A worker must point at the Atlas service');
  const ca = await inService('worker', 'test -s /atlas-state/ca.pem && echo present');
  assert.equal(ca, 'present', 'the CA generated by init-atlas must be readable by the hosts');
  const hostB = await inService('workerB', 'echo "$MERCURY_ATLAS_URL $MERCURY_ATLAS_HOST_ID"');
  assert.equal(hostB, 'https://atlas:4100 host-b', 'host B must carry its own identity');

  // The verified-TLS path, exercised exactly as the hosts exercise it: caFile against the
  // self-signed pair, hostname `atlas` checked through SAN.
  const health = await atlasFetch('worker', 'GET', '/healthz', '');
  assert.equal(health.status, 200, `atlas /healthz over the container CA: ${health.body}`);
});

guarded('a note learned on host A is materialized on host B through Atlas', async () => {
  // ---- the project: created by the operator-side act an operator would do first. ----
  const created = await atlasFetch('worker', 'POST', `/v1/projects`, ADMIN,
    { id: ATLAS_PROJECT, name: 'E2E Bridge', repoIdentities: [] });
  assert.ok([201, 409].includes(created.status), `project create: ${created.status} ${created.body}`);

  // ---- HOST A: a Run learns the lesson and reports it. ----
  const first = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    {
      task: LESSON_A,
      agent: 'note-writer',
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' },
    },
    'create teaching run',
  );
  assert.equal(first.status, 201, `create failed: ${JSON.stringify(first.body)}`);
  const teachId = first.body.runId;

  const taught = await pollRun(alice, teachId, (r) => TERMINAL.has(r.status), 'a terminal state', 90_000);
  assert.equal(taught.status, 'COMPLETED', `teaching run failed: ${taught.error ?? ''}`);

  // The tier-1 file the agent wrote, in the workspace the WORKER created -- checked from the
  // container, not the host, because the host has no mount into it.
  const noted = await inService('worker',
    `grep -c ${shellQuote(LESSON_A)} ${taught.workspacePath}/.mercury/notes.jsonl`);
  assert.equal(noted, '1', 'the note must be in the tier-1 file of the teaching workspace');

  // ---- Atlas: the pusher drains host A's outbox; the note arrives as a candidate. ----
  await pollExec('worker', 'the note reaching Atlas as a candidate', 30_000, async () => {
    const feed = await atlasFetch('worker', 'GET', `/v1/projects/${ATLAS_PROJECT}/notes?since=0&tier=all`, TOKEN_A);
    if (feed.status !== 200) return false;
    const parsed = JSON.parse(feed.body) as { notes: Array<{ claim: string }> };
    return parsed.notes.some((n) => n.claim.includes('KILNROOT-4c7a92'));
  });

  // Find the note id, then promote it -- the curation act section 12 requires before any host
  // serves a note into a Run.
  const feed = await atlasFetch('worker', 'GET', `/v1/projects/${ATLAS_PROJECT}/notes?since=0&tier=all`, TOKEN_A);
  const parsed = JSON.parse(feed.body) as { notes: Array<{ noteId: string; claim: string }> };
  const note = parsed.notes.find((n) => n.claim.includes('KILNROOT-4c7a92'));
  assert.ok(note, 'the promoted-candidate note must be in the Atlas feed');
  const promoted = await atlasFetch('worker', 'POST',
    `/v1/projects/${ATLAS_PROJECT}/notes/${note!.noteId}/promote`, ADMIN,
    { reason: 'e2e: taught on host a, verified by the scenario' });
  assert.equal(promoted.status, 200, `promote: ${promoted.status} ${promoted.body}`);

  // ---- HOST B: its puller converges the replica. Nothing is shared but Atlas. ----
  await pollExec('workerB', 'the promoted note reaching host B replica', 30_000, async () => {
    const row = await inService('workerB',
      `node -e ${shellQuote(countScript('/state/mercury.db',
        `SELECT COUNT(*) AS c FROM knowledge_replica WHERE project_id = '${ATLAS_PROJECT}' AND tier = 'promoted'`))}`);
    return JSON.parse(row).c === 1;
  });

  // ---- HOST B: a fresh Run gets the note in NOTES.md. ----
  // The pack is SELECTED AT CREATE from the replica snapshot, so this Run must be created only
  // after convergence -- an earlier create would freeze an empty pack forever.
  const second = await bob.post<{ runId: string; status: string }>(
    '/api/runs',
    { task: 'verify the release artefact', agent: 'fake',
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' } },
    'create reading run on host B',
  );
  assert.equal(second.status, 201, `host B create failed: ${JSON.stringify(second.body)}`);
  const readId = second.body.runId;
  const read = await pollRun(bob, readId, (r) => TERMINAL.has(r.status), 'a terminal state', 90_000);
  assert.equal(read.status, 'COMPLETED', `reading run failed: ${read.error ?? ''}`);

  const pack = await inService('workerB',
    `grep -c ${shellQuote('KILNROOT-4c7a92')} ${read.workspacePath}/.mercury/knowledge/NOTES.md`);
  assert.equal(pack, '1',
    'host B workspace must materialize the note host A taught; nothing but Atlas connects them');

  // And the knowledge.selected event must say where it came from: one note, chosen by selection,
  // not an empty pack the assertion could have misread.
  const detail = await bob.get<{ events: Array<{ type: string; payload?: Record<string, unknown> }> }>(
    `/api/runs/${readId}/events`, 'reading run events');
  const selected = detail.events.find((e) => e.type === 'knowledge.selected');
  assert.ok(selected, 'the reading run must record a knowledge.selected event');
  assert.equal(selected!.payload?.count, 1, `the pack must hold exactly the taught note: ${JSON.stringify(selected!.payload)}`);
});

guarded('with Atlas stopped, host A still completes and the outbox holds the note (K4)', async () => {
  // Stop BEFORE submitting: the run must not depend on a push happening concurrently. The compose
  // CLI, not the handle: the handle's stop() would remove the container, and the same container
  // must come back for the restart leg below.
  await compose(['stop', 'atlas']);

  const created = await alice.post<{ runId: string; status: string }>(
    '/api/runs',
    { task: LESSON_B, agent: 'note-writer',
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' } },
    'create offline teaching run',
  );
  assert.equal(created.status, 201);
  const offlineId = created.body.runId;
  const done = await pollRun(alice, offlineId, (r) => TERMINAL.has(r.status), 'a terminal state', 90_000);
  assert.equal(done.status, 'COMPLETED',
    `a host must keep completing Runs while Atlas is down (K4): ${done.error ?? ''}`);

  // The note is durable in the outbox: deliverable when Atlas returns, held otherwise.
  const depth = await inService('worker',
    `node -e ${shellQuote(countScript('/state/mercury.db', 'SELECT COUNT(*) AS c FROM knowledge_outbox'))}`);
  assert.ok(JSON.parse(depth).c >= 1, `the outbox must hold the undelivered note, got ${depth}`);

  // Restarting Atlas drains it -- the containerized twin of the contract test's restart leg.
  await compose(['start', 'atlas']);
  await pollExec('worker', 'the outbox draining after Atlas restarts', 60_000, async () => {
    const d = await inService('worker',
      `node -e ${shellQuote(countScript('/state/mercury.db', 'SELECT COUNT(*) AS c FROM knowledge_outbox'))}`);
    return JSON.parse(d).c === 0;
  });
});
