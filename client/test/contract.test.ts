// Contract tests against a REAL Mercury server (docs/cli-tui-design.md §15.2).
//
// Why a subprocess and not an import: §15.4 forbids any client module importing src/, and a test
// file under client/ is a client module. Spawning `node src/cli.ts server` keeps that rule intact
// while still exercising the real wire format. A hand-written fake would have been easier and would
// have proven less -- a fake that agrees with the client's own assumptions cannot detect the drift
// that the deliberate DTO duplication in protocol.ts makes possible.
//
// These are the tests that fail when the server changes a field name and the client does not.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = join(import.meta.dirname, '..', '..');
const BIN = join(import.meta.dirname, '..', 'bin.ts');
const TOKEN = 'tok-contract-alice';

let serverUrl = '';
let serverDir = '';
let server: ReturnType<typeof spawn> | null = null;

/** Ask the OS for a free port rather than guessing one and racing another process. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') { probe.close(); reject(new Error('no port')); return; }
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<string> {
  const port = await freePort();
  serverDir = mkdtempSync(join(tmpdir(), 'mercuryctl-contract-'));
  server = spawn(process.execPath, ['--no-warnings', join(REPO, 'src', 'cli.ts'), 'server'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MERCURY_DB: join(serverDir, 'contract.db'),
      MERCURY_PORT: String(port),
      MERCURY_BIND_HOST: '127.0.0.1',
      MERCURY_API_TOKENS: `${TOKEN}:alice`,
      MERCURY_EMBEDDED_WORKER: 'false',
    },
  });
  const url = `http://127.0.0.1:${port}`;
  // Poll the real endpoint rather than sleeping a fixed time: a fixed sleep is either too short and
  // flaky or too long and slow, and it says nothing about readiness.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}`);
    try {
      const res = await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.ok) return url;
    } catch {
      /* not listening yet */
    }
    await delay(250);
  }
  throw new Error('server did not become ready');
}

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      MERCURY_CLIENT_URL: serverUrl,
      MERCURY_CLIENT_TOKEN: TOKEN,
      // A developer's own profile and credential store must not leak into a contract test and make
      // it pass or fail for reasons unrelated to the server under test. XDG_CONFIG_HOME is the real
      // override (client/credentials.ts configDir); pointing it at a directory that does not exist
      // means a stray ~/.config/mercury on the test machine cannot be consulted.
      XDG_CONFIG_HOME: join(serverDir, 'no-such-config'),
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

async function createRun(task: string): Promise<string> {
  const res = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ task, repository: { url: 'https://example.invalid/r.git' } }),
  });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
  return res.body.runId as string;
}

before(async () => {
  serverUrl = await startServer();
});

after(() => {
  server?.kill('SIGTERM');
  if (serverDir) rmSync(serverDir, { recursive: true, force: true });
});

test('agents list shows the server\u0027s real agent ids', () => {
  const r = cli(['agents', 'list']);
  assert.equal(r.code, 0, r.stderr);
  // Transcribed from the live server rather than from a doc table: the set of accepted ids is the
  // server's business, and a client that hard-coded them would drift.
  assert.match(r.stdout, /primeagent/);
  assert.match(r.stdout, /default/);
});

test('agents list --json emits exactly one JSON value in the server shape', () => {
  const r = cli(['agents', 'list', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout); // throws if stdout is anything but one value
  assert.ok(Array.isArray(parsed.agents));
  assert.equal(typeof parsed.defaultAgent, 'string');
});

test('runs list shows a Run created through the API', async () => {
  const runId = await createRun('contract: list me');
  const r = cli(['runs', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(runId), `created Run ${runId} missing from:\n${r.stdout}`);
  assert.match(r.stdout, /QUEUED/);
});

test('runs list --json is machine-readable and carries the opaque cursor unchanged', async () => {
  await createRun('contract: page one');
  await createRun('contract: page two');
  const r = cli(['runs', 'list', '--json', '--limit', '1']);
  assert.equal(r.code, 0, r.stderr);
  const page = JSON.parse(r.stdout);
  assert.equal(page.runs.length, 1);
  assert.equal(typeof page.nextCursor, 'string');

  // The client must hand the server's cursor back verbatim. It never parses it, so whatever the
  // server encodes inside survives a round trip.
  const next = cli(['runs', 'list', '--json', '--limit', '1', '--cursor', page.nextCursor]);
  assert.equal(next.code, 0, next.stderr);
  const page2 = JSON.parse(next.stdout);
  assert.equal(page2.runs.length, 1);
  assert.notEqual(page2.runs[0].id, page.runs[0].id, 'cursor did not advance the page');
});

test('runs show renders a Run and exits 0 for a non-terminal status', async () => {
  const runId = await createRun('contract: show me in full');
  const r = cli(['runs', 'show', runId]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(runId));
  assert.match(r.stdout, /contract: show me in full/);
  assert.match(r.stdout, /QUEUED/);
});

test('runs show --json returns the run and skills pair the server actually sends', async () => {
  const runId = await createRun('contract: json detail');
  const r = cli(['runs', 'show', runId, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const detail = JSON.parse(r.stdout);
  // GET /runs/:id returns { run, skills }. Not RunSkill, not a flat Run -- the shape here is the
  // reason these tests talk to a real server instead of a fixture.
  assert.equal(detail.run.id, runId);
  assert.ok(Array.isArray(detail.skills));
});

test('a Run whose repository url carries control sequences is sanitised too', async () => {
  // Added after mutation testing: the task-text test alone left the repository field unguarded, so
  // dropping sanitizeForTerminal there kept the whole suite green. A Run's repository is as
  // attacker-influenced as its task -- anyone who can create a Run can name its url -- so every
  // untrusted field rendered into a terminal needs its own test, not one representative field.
  const evilRepo = 'https://example.invalid/\u001b[2Jpwned.git';
  const res = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ task: 'contract: evil repo', repository: { url: evilRepo } }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const r = cli(['runs', 'show', res.body.runId]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('\u001b'), 'a raw escape sequence reached stdout from the repository field');
  assert.match(r.stdout, /example\.invalid/);
});

test('a Run in a TERMINAL status is shown with exit 0', async () => {
  // §6.1: a terminal status is data, not a command failure. Reached for real here -- the Run is
  // cancelled through the API so the server itself reports CANCELLED, rather than a fixture that
  // asserts the behaviour by construction. Without this, `mercuryctl runs show $id || echo retry`
  // would treat a successful read as a failure the moment a Run finished.
  const runId = await createRun('contract: cancel me');
  const cancelled = await api(`/api/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const r = cli(['runs', 'show', runId]);
  assert.equal(r.code, 0, `terminal Run must exit 0, got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout, /CANCELLED/);

  const j = cli(['runs', 'show', runId, '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).run.status, 'CANCELLED');
});

test('runs show with no id is a usage error, not a crash', () => {
  const r = cli(['runs', 'show']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a run id/);
});

test('an unknown status is rejected locally with the valid set', () => {
  const r = cli(['runs', 'list', '--status', 'NOPE']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /RUNNING/);
});

test('a bad token exits 3 and does not print the token', () => {
  const r = cli(['runs', 'list'], { MERCURY_CLIENT_TOKEN: 'tok-definitely-wrong' });
  assert.equal(r.code, 3);
  assert.ok(!r.stdout.includes('tok-definitely-wrong'));
  assert.ok(!r.stderr.includes('tok-definitely-wrong'), 'the bearer token reached stderr');
});

test('an unknown Run id exits 4', async () => {
  const r = cli(['runs', 'show', 'run_does_not_exist']);
  assert.equal(r.code, 4);
});

test('a dead endpoint exits 7 with a transport message, not a stack trace', () => {
  const port = 1; // nothing listens here
  const r = cli(['runs', 'list'], { MERCURY_CLIENT_URL: `http://127.0.0.1:${port}` });
  assert.equal(r.code, 7);
  assert.ok(!r.stderr.includes('at '), `stack trace leaked:\n${r.stderr}`);
});

test('a Run whose task contains terminal control sequences cannot inject them', async () => {
  // The task text comes back verbatim over the wire, so this is the end-to-end version of the
  // sanitiser test: it proves the escape never reaches the terminal, not merely that a function
  // exists that would strip it.
  const evil = 'before\u001b]0;pwned\u0007after\u001b[2J';
  const runId = await createRun(evil);
  const r = cli(['runs', 'show', runId]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('\u001b'), 'a raw escape sequence reached stdout');
  assert.match(r.stdout, /before/);
  // JSON mode keeps the bytes: its contract is data fidelity, and jq needs the real value.
  const j = cli(['runs', 'show', runId, '--json']);
  assert.ok(JSON.parse(j.stdout).run.task.includes('\u001b'), 'JSON mode must not alter data');
});
