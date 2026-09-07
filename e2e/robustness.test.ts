/**
 * Phase 5 -- robustness of the gate itself.
 *
 * The other e2e files ask "does Mercury work?". This one asks "does the GATE survive the things that
 * make test harnesses untrustworthy": two developers running it at once, a service that accepts a
 * request and never answers, a stream that never ends, a service that logs without bound, and a
 * teardown that fails while a scenario is already failing.
 *
 * Each of those fails in a way that looks like something else -- a hung harness looks like a slow
 * test, a swallowed teardown looks like a pass -- so they are asserted directly rather than trusted.
 *
 * Run with `npm run test:e2e`, or the Docker-free half alone with:
 *   node --test --test-name-pattern 'no Docker daemon' e2e/robustness.test.ts
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';
import {
  COMPOSE_FILE, DIAGNOSTIC_CAP_BYTES, E2E_DIR, LIMITS, PROJECT_PREFIX,
  capBuffer, deadServices, assertServicesAlive, inspectionCommands, preflight, teardownOutcome,
} from './preflight.ts';
import { client, pollRun } from './helpers.ts';

const suffix = () => Math.random().toString(36).slice(2, 10);
const running: StartedDockerComposeEnvironment[] = [];

after(async () => {
  // Best-effort and ordered: a leak from the cleanup of one stack must not skip the other.
  for (const env of running) {
    try { await env.down({ removeVolumes: true }); } catch { /* reported by the test that owns it */ }
  }
  running.length = 0;
});

/** Bring one stack up under an explicit project name, so two can coexist by construction. */
async function bringUp(project: string) {
  const env = await new DockerComposeEnvironment(E2E_DIR, 'compose.yml')
    .withBuild()
    .withProjectName(project)
    .withAutoCleanup(true)
    .withStartupTimeout(LIMITS.startupMs)
    .withWaitStrategy('fixture-1', Wait.forOneShotStartup())
    .withWaitStrategy('api-1', Wait.forHealthCheck())
    .withWaitStrategy('worker-1', Wait.forLogMessage(/worker started/, 1))
    .up();
  running.push(env);
  const api = env.getContainer('api-1');
  return { env, base: `http://${api.getHost()}:${api.getMappedPort(3000)}` };
}

test('two E2E projects run concurrently without sharing state', async () => {
  await preflight();
  const [a, b] = await Promise.all([bringUp(`mercury-e2e-par-${suffix()}`), bringUp(`mercury-e2e-par-${suffix()}`)]);

  // Each stack gets its own named volume, so a Run submitted to one must be invisible to the other.
  // Sharing a volume here would show up as a Run that exists in a project that never created it.
  const [runA, runB] = await Promise.all([a, b].map(async ({ base }, i) => {
    const c = client(base, 'tok-alice');
    const created = await c.post<{ runId: string }>('/api/runs', {
      task: `parallel probe ${i}`,
      agent: 'fake',
      repository: { localPath: '/state/fixture-repo', baseBranch: 'main' },
    }, 'create parallel run');
    assert.equal(created.status, 201, `stack ${i} rejected the run: ${JSON.stringify(created.body)}`);
    const done = await pollRun(c, created.body.runId, (r) => r.status === 'COMPLETED', 'COMPLETED', 120_000);
    return { c, runId: created.body.runId, status: done.status };
  }));

  assert.equal(runA.status, 'COMPLETED');
  assert.equal(runB.status, 'COMPLETED');

  // The isolation claim, checked rather than assumed: A cannot see B's Run.
  await assert.rejects(() => runA.c.get(`/api/runs/${runB.runId}`, 'cross-project read'),
    (err: unknown) => (err as { status?: number }).status === 404,
    'a Run from the other project must not be readable; a shared database would make this a 200');
});

test('a request that is accepted and never answered cannot hang the harness -- no Docker daemon', async () => {
  const server = createServer(() => { /* accept the socket, never respond */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const startedAt = Date.now();
    await assert.rejects(() => client(base, 'tok').get('/api/runs', 'hung list'),
      'an unanswered request must reject, not wait forever');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < LIMITS.requestMs + 10_000,
      `the request outlived its own deadline: ${elapsed}ms vs ${LIMITS.requestMs}ms`);
  } finally {
    server.close();
  }
});

test('an SSE stream that never emits a frame cannot hang the reader -- no Docker daemon', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': open but silent\n\n');   // a comment line: a real keepalive, and not a frame
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { readSse } = await import('./helpers.ts');
    const startedAt = Date.now();
    await assert.rejects(() => readSse(base, 'tok-alice', 'run_silent', 3_000),
      'a silent stream must end in a deadline error, not in a hung test');
    assert.ok(Date.now() - startedAt < 30_000, 'the reader ignored its deadline');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('diagnostics are size-capped -- no Docker daemon', () => {
  assert.ok(Number.isFinite(DIAGNOSTIC_CAP_BYTES) && DIAGNOSTIC_CAP_BYTES > 0,
    'the cap must be a real bound');
  const chatty = Buffer.alloc(DIAGNOSTIC_CAP_BYTES * 3, 'x');
  assert.equal(capBuffer(chatty).byteLength, DIAGNOSTIC_CAP_BYTES,
    'a chatty service must not be able to grow a diagnostics file past the cap');
  const small = Buffer.from('short');
  assert.equal(capBuffer(small).byteLength, small.byteLength, 'small logs must survive intact');
});

test('a retained project prints exact, runnable inspection and cleanup commands -- no Docker daemon', () => {
  const cmds = inspectionCommands('mercury-e2e-abcd1234');
  assert.ok(cmds.length >= 3, 'expected inspect, logs and cleanup commands');
  for (const cmd of cmds) {
    assert.ok(cmd.startsWith('docker '), `not runnable as-is: ${cmd}`);
    assert.ok(cmd.includes('-p mercury-e2e-abcd1234'),
      `a command without the project name would act on the wrong stack or nothing: ${cmd}`);
  }
  assert.ok(cmds.some((c) => c.includes('down -v')),
    'the retained-project message must include the teardown, or the developer has to reconstruct it');
});

test('a teardown failure never replaces the scenario failure -- no Docker daemon', () => {
  const scenario = new Error('run run_x never left QUEUED');
  const busy = new Error('volume is in use');

  const afterFailure = teardownOutcome(scenario, busy);
  assert.equal(afterFailure.propagate, false,
    'raising the teardown error would hide the scenario failure that caused it');
  assert.match(afterFailure.log, /volume is in use/, 'the teardown problem must still be reported');
  assert.match(afterFailure.log, /already failed/, 'and must say why it is not being raised');
  // The message claims the scenario failure "is the failure to read". A pointer that never names its
  // target sends the reader back to square one, so the claim is asserted rather than decorated.
  assert.match(afterFailure.log, /run run_x never left QUEUED/,
    'the log must name the scenario failure it tells the reader to go and read');

  const cleanRun = teardownOutcome(undefined, busy);
  assert.equal(cleanRun.propagate, true,
    'with no scenario failure the teardown IS the failure; swallowing it would report green over a leak');
  assert.ok(!cleanRun.log.includes('already failed'),
    'a clean run must not claim a scenario failed');

  // A non-Error throw must still be named rather than rendered as "undefined".
  assert.match(teardownOutcome('boom', busy).log, /boom/, 'a thrown non-Error must still be named');
});

/**
 * Abrupt exit of the test process, which no explicit `down` can cover.
 *
 * A killed harness runs no `after()` hook, so everything it started would outlive it unless something
 * else reaps it. That is Ryuk's job, and this asserts the two properties that make the guarantee real:
 * a reaper is actually running, and every container the gate starts carries the session label Ryuk
 * reaps on. A container with no session label is invisible to Ryuk and would leak on every Ctrl-C.
 *
 * What this deliberately does NOT assert is *how fast* a killed client's container disappears.
 * Testcontainers reuses a single shared Ryuk across processes (reaper.js: findReaperContainers ->
 * useExistingReaper), so reaping is only observed once the last client on that Ryuk disconnects.
 * Asserting a fixed window therefore passes when this file runs alone and fails when the compose
 * suites are up beside it -- a real measurement, verified both ways:
 *
 *   alone:                       reaped in ~11s, pass
 *   alongside another suite:     still running after 60s, fail
 *   TESTCONTAINERS_RYUK_DISABLED: still running, fail (the assertion does bite)
 *
 * The timing is a property of the shared reaper, not of Mercury, so encoding it as a gate assertion
 * would manufacture a flake and teach the next reader to distrust this file.
 */
test('every container the gate starts is visible to the reaper', async () => {
  await preflight();
  const { writeFileSync, rmSync } = await import('node:fs');
  const script = join(E2E_DIR, `.reaper-probe-${process.pid}.mjs`);
  writeFileSync(script, [
    "import { GenericContainer } from 'testcontainers';",
    "const c = await new GenericContainer('alpine:latest').withCommand(['sleep', '600']).start();",
    "process.stdout.write(c.getId() + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join('\n'));

  const child = spawn(process.execPath, [script], { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  try {
    const containerId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the probe never started a container')), 120_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const match = stdout.match(/[0-9a-f]{12,64}/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timer); reject(new Error(`probe exited early (code ${code}): ${stdout}`)); });
    });

    const inspect = spawnSync('docker', ['container', 'inspect',
      '-f', '{{index .Config.Labels "org.testcontainers.session-id"}}|{{index .Config.Labels "org.testcontainers.ryuk"}}',
      containerId], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(inspect.status, 0, `probe container ${containerId.slice(0, 12)} was not inspectable: ${inspect.stderr}`);
    // Assert the shape before destructuring. Without this a line missing the separator leaves
    // `isReaper` undefined and the expression below throws "Cannot read properties of undefined",
    // which reads as a bug in the test rather than "docker answered in a shape I did not expect".
    const parts = inspect.stdout.trim().split('|');
    assert.equal(parts.length, 2, `unexpected inspect output, wanted "<session>|<ryuk>": ${inspect.stdout}`);
    const [session, isReaper] = parts;
    assert.ok(session.length > 0 && !isReaper.length,
      `container carries no reaper session label (got "${session}"); Ryuk cannot reap what it cannot `
      + 'attribute to a session, so it would outlive a killed harness');

    // A reaper must exist for that session to be reaped at all.
    const ryuks = spawnSync('docker', ['ps', '-q', '--filter', 'label=org.testcontainers.ryuk=true'],
      { encoding: 'utf8', timeout: 30_000 });
    assert.ok(ryuks.stdout.trim().split('\n').filter(Boolean).length >= 1,
      'no Ryuk reaper is running; nothing would clean up after an abrupt exit');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(script, { force: true });
    // This probe is not reaped by the assertion above, so clean it up explicitly rather than leaving
    // it for a shared reaper whose timing this file refuses to assert.
    spawnSync('bash', ['-c', 'docker ps -aq --filter ancestor=alpine:latest --filter status=running | xargs -r docker rm -f >/dev/null 2>&1'],
      { encoding: 'utf8', timeout: 120_000 });
  }
});

/**
 * The guard that `up()` cannot provide, proven by a service that actually dies.
 *
 * A compose healthcheck reports `healthy` from the moment the probe succeeds, and Testcontainers'
 * wait strategy returns on the first `healthy` it sees. A process that answers the probe and then
 * dies -- here, the API failing to open its database -- therefore lets `up()` resolve over a dead
 * container. Every test after that fails with ECONNREFUSED, and the one line that explains why is
 * nowhere in the output.
 *
 * This test exists because a guard whose only evidence is "no violations on a healthy stack" is not
 * proven to report anything. The override makes the API die for real, and the assertion is that the
 * report names it and carries the reason.
 */
test('a service that dies after its healthcheck passes is named, with its reason', async () => {
  await preflight();
  const project = `${PROJECT_PREFIX}-dead-${suffix()}`;
  const env = await new DockerComposeEnvironment(E2E_DIR, ['compose.yml', 'crash-override.yml'])
    .withProjectName(project)
    .withStartupTimeout(LIMITS.startupMs)
    .withWaitStrategy('fixture-1', Wait.forOneShotStartup())
    .withWaitStrategy('api-1', Wait.forHealthCheck())
    .up();
  running.push(env);

  // assertServicesAlive is what system.test.ts's startup path calls, so this exercises the guard the
  // gate actually relies on rather than a helper that merely resembles it.
  const failure = await assertServicesAlive(project, ['api', 'worker']).then(
    () => null, (err: unknown) => (err as Error).message);
  assert.ok(failure !== null,
    'the guard returned cleanly over a dead API; the suite would proceed and fail eleven times for a reason it never prints');
  assert.match(failure, /api-1: state=/,
    'the dead API must be named; a clean return here means the guard is blind to the exact race it exists for');
  assert.match(failure, /state=exited/, 'the report must carry the container state, not just a name');
  assert.match(failure, /unable to open database file/,
    'the report must carry the log line that explains the death, or the reader still has to go find it');
  assert.ok(!/worker-1: state=/m.test(failure),
    'the worker is healthy in this scenario; a report that blames everything is not a diagnosis');

  // Same stack, so this also closes the design gate item "success and failure leave no Compose
  // resources": teardown of a project whose service died must be complete, not best-effort.
  await env.down({ removeVolumes: true });
  const idx = running.indexOf(env);
  if (idx >= 0) running.splice(idx, 1);
  const { spawnSync } = await import('node:child_process');
  const left = spawnSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(left.stdout.trim(), '', `teardown left containers behind: ${left.stdout}`);
  const vols = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(vols.stdout.trim(), '', `teardown left the state volume behind: ${vols.stdout}`);
});

/**
 * The naming rule, without a Docker daemon.
 *
 * Compose names containers `<project>-<service>-<index>`. A guard that hardcodes index 1 says "all
 * fine" while `api-2` dies behind a live `api-1`, and that is invisible until someone scales a
 * service. These cases pin the rule that the live test above cannot reach.
 */
test('the liveness guard covers every replica, not just the first -- no Docker daemon', () => {
  const P = 'mercury-e2e-x';
  const alive = { [`${P}-api-1`]: 'running', [`${P}-worker-1`]: 'running' };
  assert.deepEqual(deadServices(alive, P, ['api', 'worker']), [], 'a healthy stack must produce no problems');

  // The case a hardcoded "-1" misses.
  const secondDead = { [`${P}-api-1`]: 'running', [`${P}-api-2`]: 'exited', [`${P}-worker-1`]: 'running' };
  assert.deepEqual(deadServices(secondDead, P, ['api', 'worker']), [`${P}-api-2: state=exited`],
    'a dead second replica behind a live first one must still be reported');

  // Every replica, not just the first dead one.
  const allDead = { [`${P}-api-1`]: 'exited', [`${P}-api-2`]: 'dead' };
  assert.equal(deadServices(allDead, P, ['api']).length, 2, 'every dead replica must be listed');

  // A service that never got a container is a problem, not a pass.
  assert.match(deadServices({}, P, ['api'])[0], /no container matching api-<n>/,
    'a missing service must be reported rather than silently absent');

  // One-shot services legitimately exit, so they are simply not in the expected list -- and only the
  // services named there are judged. A missing expected service is still reported, which is the point.
  const withFixture = { [`${P}-api-1`]: 'running', [`${P}-fixture-1`]: 'exited' };
  assert.deepEqual(deadServices(withFixture, P, ['api']), [],
    'an exited one-shot must not be blamed when it is not an expected long-lived service');
  assert.equal(deadServices(withFixture, P, ['api', 'worker']).length, 1,
    'a service that is expected but absent must still be reported, one-shot or not');

  // A project name containing regex metacharacters must not widen or break the match.
  const tricky = 'mercury.e2e+x';
  const trickyStates = { 'mercuryXe2eXapi-1': 'exited', [`${tricky}-api-1`]: 'running' };
  assert.deepEqual(deadServices(trickyStates, tricky, ['api']), [],
    'an unescaped project name lets "." and "+" match unrelated containers and misreport them');
});
