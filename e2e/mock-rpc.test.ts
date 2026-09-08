/**
 * Phase 4 -- the mock PrimeAgent RPC journey, including human input.
 *
 * The fake adapter can never park a Run in NEEDS_INPUT: only an adapter that speaks the RPC dialog
 * can, and driving a real agent from a gate would make the gate need a provider credential and a
 * network. The repository already ships a fixture that speaks the real JSONL RPC protocol
 * (`test/fixtures/mock-prime-agent-rpc.mjs`), so this file points the worker's `primeagent` adapter
 * at it and walks the one flow nothing else covers end to end:
 *
 *   client -> API -> queue -> worker -> RPC subprocess -> input.required
 *          -> client answers through the public API -> subprocess resumes -> COMPLETED
 *
 * The stack is started with MERCURY_E2E_MOCK_RPC_MODE=input so the fixture asks; every other stack
 * gets `happy` from compose.yml and behaves exactly as before.
 *
 * Run with `npm run test:e2e` (collected with the rest of e2e/).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';
import { COMPOSE_FILE, E2E_DIR, LIMITS, composeModel, keepOnFail, preflight } from './preflight.ts';
import { client, pollRun, type RunEvent, type RunView } from './helpers.ts';

const PROJECT = `mercury-e2e-mock-${Math.random().toString(36).slice(2, 10)}`;
const SVC = { api: 'api-1', worker: 'worker-1' } as const;

let env: StartedDockerComposeEnvironment | undefined;
let apiBase = '';
let alice: ReturnType<typeof client>;
let scenarioFailed = false;

/** Bounded `docker compose` call. `timeout` does not exist on macOS, so the bound is explicit. */
function compose(args: string[], timeoutMs = LIMITS.diagnosticsMs): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args],
      { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out: out + '\n<killed: compose did not finish>' });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; });
    child.stderr.on('data', (c: string) => { out += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function guarded(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    scenarioFailed = true;
    // The mock is a subprocess of the worker, so its own stdout is the only record of what it was
    // asked and what it answered. Without this, an input failure is a status code and nothing else.
    const logs = await compose(['logs', '--no-color', 'worker'], LIMITS.diagnosticsMs);
    throw new Error(`${name}: ${(err as Error).message}\n--- worker.log (tail) ---\n${logs.out.slice(-4_000)}`);
  }
}

before(async () => {
  await preflight();
  const started = await new DockerComposeEnvironment(E2E_DIR, 'compose.yml')
    .withBuild()
    .withProjectName(PROJECT)
    .withAutoCleanup(!keepOnFail())
    .withStartupTimeout(LIMITS.startupMs)
    // Drives the ${MERCURY_E2E_MOCK_RPC_MODE:-happy} interpolation in compose.yml: this stack wants
    // the fixture to ask for input. Compose reads it from the environment of the compose process.
    .withEnvironment({ MERCURY_E2E_MOCK_RPC_MODE: 'input' })
    .withWaitStrategy('fixture-1', Wait.forOneShotStartup())
    .withWaitStrategy(SVC.api, Wait.forHealthCheck())
    .withWaitStrategy(SVC.worker, Wait.forLogMessage(/worker started/, 1))
    .up();
  env = started;
  const api = started.getContainer(SVC.api);
  apiBase = `http://${api.getHost()}:${api.getMappedPort(3000)}`;
  alice = client(apiBase, 'tok-alice');
});

after(async () => {
  if (!env) return;
  if (scenarioFailed && keepOnFail()) {
    console.error(`e2e(mock): FAILED, keeping resources.\n  cleanup: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v`);
    return;
  }
  await env.down({ removeVolumes: true });
});

test('the worker is wired to the repository mock, not to a real agent binary', async () => {
  // This runs first on purpose: if the adapter ever points back at a real `prime-agent` on PATH, every
  // scenario below would try to reach a provider.
  //
  // It asserts the WIRING, not a nearby structural fact. An earlier version of this test checked only
  // that the worker publishes no port -- which stayed green through the exact defect this file exists
  // to prevent, because pointing MERCURY_PRIMEAGENT_CMD back at the node binary changes nothing about
  // ports. A guard that cannot fail for the bug it names is not a guard.
  const model = await composeModel();
  const worker = model.services.worker;
  assert.ok(worker, 'worker service missing');
  const env = (worker as unknown as { environment?: Record<string, string | number | null> }).environment ?? {};
  const cmd = String(env.MERCURY_PRIMEAGENT_CMD ?? '');

  assert.ok(cmd.endsWith('/test/fixtures/mock-prime-agent-rpc.mjs'),
    `the gate must run the repository mock, got MERCURY_PRIMEAGENT_CMD="${cmd}"`);
  // The defect itself, named: the adapter prepends `--mode rpc`, which is prime-agent's CLI and not
  // Node's, so an interpreter here dies with "node: bad option: --mode" (exit 9).
  assert.ok(!/(^|\/)(node|npm|npx|sh|bash)$/.test(cmd),
    `MERCURY_PRIMEAGENT_CMD must be the command itself, not an interpreter that receives --mode rpc: "${cmd}"`);
  assert.ok(!('MERCURY_PRIMEAGENT_ARGS' in env),
    'the fixture must not be passed as an argument to an interpreter; that is how the exit-9 wiring happened');
  assert.ok(!worker.ports || worker.ports.length === 0, 'the worker must publish no port');

  // Why the fixture can be the command at all: it is executable and carries a node shebang, so the
  // adapter's `--mode rpc` prefix lands in its argv and is ignored, exactly as in the adapter's unit
  // tests. Without both properties the wiring above would be wrong in a different way.
  const fixture = readFileSync(join(E2E_DIR, '..', 'test', 'fixtures', 'mock-prime-agent-rpc.mjs'), 'utf8');
  assert.match(fixture.split('\n')[0], /^#!\/usr\/bin\/env node/, 'the fixture needs a node shebang to be a command');
  const mode = statSync(join(E2E_DIR, '..', 'test', 'fixtures', 'mock-prime-agent-rpc.mjs')).mode;
  assert.ok(mode & 0o111, 'the fixture must be executable to be spawned directly');
});

test('a primeagent Run reaches NEEDS_INPUT and the answer reaches the subprocess', async () => {
  await guarded('input journey', async () => {
    const created = await alice.post<{ runId: string; status: string }>(
      '/api/runs',
      {
        task: 'E2E mock RPC input journey',
        agent: 'primeagent',
        repository: { localPath: '/state/fixture-repo', baseBranch: 'main' },
      },
      'create primeagent run',
    );
    assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    const runId = created.body.runId;

    // The adapter must surface the subprocess's dialog as a Run state, not as a log line.
    const waiting = await pollRun(alice, runId, (r) => r.status === 'NEEDS_INPUT', 'NEEDS_INPUT', 90_000);
    assert.equal(waiting.status, 'NEEDS_INPUT');

    const events = await alice.get<{ events: RunEvent[] }>(`/api/runs/${runId}/events`, 'events while waiting');
    const asked = events.events.find((e) => e.type === 'input.required');
    assert.ok(asked, `the RPC dialog must surface as input.required; saw ${events.events.map((e) => e.type).join(', ')}`);

    // Answer through the public API only. Nothing here touches the subprocess directly, so this is
    // the whole path a human takes: HTTP in, queue to worker, JSONL to the child.
    const answered = await alice.post(`/api/runs/${runId}/input`, { input: 'e2e-answer-42' }, 'submit input');
    assert.ok(answered.status < 300, `input must be accepted, got ${answered.status}: ${JSON.stringify(answered.body)}`);

    const done = await pollRun(alice, runId, (r) => r.status === 'COMPLETED', 'COMPLETED', 90_000);
    assert.equal(done.status, 'COMPLETED');

    // The fixture echoes the value it received ("Got input: ..."), so seeing it in the persisted
    // stream proves the answer travelled all the way into the subprocess and back out as a
    // translated agent event -- not merely that the Run left NEEDS_INPUT.
    const after = await alice.get<{ events: RunEvent[] }>(`/api/runs/${runId}/events`, 'events after input');
    const echoed = after.events.find((e) => JSON.stringify(e.payload ?? {}).includes('e2e-answer-42'));
    assert.ok(echoed,
      'the subprocess must acknowledge the exact value it received; '
      + `saw ${after.events.map((e) => e.type).join(', ')}`);
  });
});

test('the mock subprocess is gone once the Run is terminal', async () => {
  await guarded('subprocess reaped', async () => {
    // The fixture records its own pid. Checking /proc rather than `kill -0` avoids a PID-reuse false
    // pass, and it runs inside the worker container, which is the only place that pid ever existed.
    const probe = await compose(['exec', '-T', 'worker', 'sh', '-c',
      'pid=$(cat /state/mock.pid 2>/dev/null || echo ""); '
      + 'if [ -z "$pid" ]; then echo NOPID; exit 0; fi; '
      + 'if [ -r /proc/$pid/cmdline ]; then tr "\\0" " " < /proc/$pid/cmdline; else echo GONE; fi']);
    // A failed exec must not read as "the process is gone": `docker compose exec` prints its own
    // error and exits non-zero, and treating that as GONE would pass whenever the worker is unhealthy.
    assert.equal(probe.code, 0, `could not inspect the worker container (exit ${probe.code}): ${probe.out.trim()}`);
    const out = probe.out.trim();
    // NOPID is a FAILURE, not a pass. The fixture writes this file unconditionally at startup, so an
    // absent file means the subprocess never ran -- and a test that accepted it would report "the
    // process is gone" about a process that never existed.
    assert.ok(!out.includes('NOPID'),
      'the mock never recorded its pid, so this proves nothing about reaping; the subprocess did not start');
    assert.ok(out.includes('GONE'),
      `the RPC subprocess must not outlive the Run; /proc says: ${out}`);
    assert.ok(!out.includes('mock-prime-agent-rpc'),
      `a live mock-prime-agent-rpc process is still running in the worker: ${out}`);
  });
});

test('no provider credential reaches the worker that runs the adapter', async () => {
  await guarded('no credentials', async () => {
    const inspect = await compose(['exec', '-T', 'worker', 'sh', '-c', 'env']);
    // `compose()` folds stderr into `out`, so a failed exec -- no worker, bad service name, daemon down --
    // produces NON-EMPTY output. The old guard only asked for non-empty, so it passed, and the credential
    // regex then found nothing credential-shaped in an error message. Asserting the exit code is what makes
    // "no credentials found" mean "we read the environment" rather than "the command never ran".
    assert.equal(inspect.code, 0,
      'docker compose exec env did not succeed (exit ' + String(inspect.code) + '); cannot conclude '
      + 'anything about credentials from its output: ' + inspect.out.slice(0, 300));
    const keys = inspect.out.split('\n').map((l) => l.split('=')[0]).filter(Boolean);
    assert.ok(keys.length > 0, 'could not read the worker environment; the check would pass vacuously');
    const credential = /ANTHROPIC|OPENAI|GOOGLE_API|AWS_(ACCESS|SECRET)|AZURE_|NPM_TOKEN|GITHUB_TOKEN|XAI_|GEMINI/i;
    const leaked = keys.filter((k) => credential.test(k));
    assert.deepEqual(leaked, [],
      `the deterministic gate must need no provider credential, found: ${leaked.join(', ')}`);
  });
});
