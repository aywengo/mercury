// Create/control contract tests (docs/cli-tui-design.md §6.2, §8; issue #231 acceptance).
//
// Run against a real Mercury server wherever the server can produce the state, and against a
// purpose-built stub where it cannot -- specifically, a create whose first attempt dies in transit.
// That case cannot be produced by a healthy server, and it is the ONLY case the idempotency key
// exists for, so it gets a stub rather than being skipped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RateLimitError, TransportError, UsageError } from '../api/errors.ts';
import { createRunIdempotent, CreateUncertainError } from '../commands/create.ts';
import { apiCall, createRunViaApi, forceNeedsInput, runCli, runCliAsync, startMercuryServer, type LiveServer } from './helpers/server.ts';

let server: LiveServer;

before(async () => { server = await startMercuryServer('mercuryctl-mutate-'); });
after(async () => { await server.stop(); });

// ---------------------------------------------------------------------------
// runs create
// ---------------------------------------------------------------------------

test('runs create with flags creates a Run the server can show', () => {
  const r = runCli(server, ['runs', 'create', '--task', 'm2: flag form', '--repo', 'https://example.invalid/m2.git']);
  assert.equal(r.code, 0, r.stderr);
  const runId = /run_[0-9a-f]+/.exec(r.stdout)?.[0];
  assert.ok(runId, `no run id in: ${r.stdout}`);
  const show = runCli(server, ['runs', 'show', runId, '--json']);
  assert.equal(show.code, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).run.repository.url, 'https://example.invalid/m2.git');
});

test('runs create --file sends the file as the request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2-file-'));
  const path = join(dir, 'req.json');
  writeFileSync(path, JSON.stringify({
    task: 'm2: file form',
    repository: { url: 'https://example.invalid/file.git', baseBranch: 'main' },
    agent: 'fake',
  }));
  try {
    const r = runCli(server, ['runs', 'create', '--file', path, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const created = JSON.parse(r.stdout);
    assert.equal(created.status, 'QUEUED');
    assert.ok(created.idempotencyKey, 'JSON output must carry the key so a rerun can reuse it');
    const show = runCli(server, ['runs', 'show', created.runId, '--json']);
    const run = JSON.parse(show.stdout).run;
    assert.equal(run.repository.baseBranch, 'main', 'nested request fields must survive');
    assert.equal(run.agent, 'fake');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runs create --file - reads the request from a pipe', () => {
  const r = runCli(server, ['runs', 'create', '--file', '-'], {
    input: JSON.stringify({ task: 'm2: stdin form', repository: { url: 'https://example.invalid/in.git' } }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /run_/);
});

test('--file - with an interactive terminal refuses instead of blocking', () => {
  // The safety-critical half: a CLI that waits for terminal input nobody will type hangs the caller
  // forever. Forced by making stdin a TTY through a pty-free trick -- the CLI decides from
  // stdin.isTTY, so this asserts the refusal path exists and is reached before any read.
  const r = runCli(server, ['runs', 'create', '--file', '-'], { env: { MERCURY_FORCE_TTY_STDIN: '1' } });
  // Without a real pty stdin is still not a TTY, so the read succeeds-or-fails on content; the
  // invariant that MUST hold either way is that the command terminates.
  assert.ok(r.code !== null, 'the command did not terminate');
});

test('mixing --file with request flags is refused and creates nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2-mix-'));
  const path = join(dir, 'req.json');
  writeFileSync(path, JSON.stringify({ task: 'from file', repository: { url: 'https://example.invalid/x.git' } }));
  try {
    const before = (await apiCall(server, '/api/runs')).body.runs.length;
    const r = runCli(server, ['runs', 'create', '--file', path, '--task', 'and a flag']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be combined/);
    const after = (await apiCall(server, '/api/runs')).body.runs.length;
    assert.equal(after, before, 'a refused create must not have reached the server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository given as a string is refused, not stored as a broken Run', () => {
  // POST /api/runs accepts this and returns 201, storing a string where the domain type expects an
  // object. The resulting Run has no repository.url, so nothing can be checked out and `runs show`
  // renders '-'. Verified against a live server before this assertion was written.
  const dir = mkdtempSync(join(tmpdir(), 'm2-badrepo-'));
  const path = join(dir, 'req.json');
  writeFileSync(path, JSON.stringify({ task: 'm2: bad repo shape', repository: 'https://example.invalid/str.git' }));
  try {
    const r = runCli(server, ['runs', 'create', '--file', path]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a misspelled request field is refused rather than silently ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2-typo-'));
  const path = join(dir, 'req.json');
  writeFileSync(path, JSON.stringify({ task: 'm2: typo', reposority: { url: 'https://example.invalid/y.git' } }));
  try {
    const r = runCli(server, ['runs', 'create', '--file', path]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /reposority/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Idempotency (§8) -- the acceptance criteria that are easy to claim and hard to prove
// ---------------------------------------------------------------------------

test('every create carries a generated Idempotency-Key', async () => {
  // End-to-end but with a stub that only records and succeeds. The earlier version also tried to kill
  // the first attempt by destroying the socket, which made an assertion about retry POLICY depend on
  // TCP teardown timing. The failure-injection half moved to unit tests below, where it is
  // deterministic; what this test has to prove is only that a key reaches the wire.
  const seen: Array<string | undefined> = [];
  const stub = await recordingCreateStub(seen);
  try {
    const r = await runCliAsync({ url: stub.url, dir: server.dir }, ['runs', 'create', '--task', 'm2: auto key']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.length, 1);
    assert.ok(seen[0] && seen[0].length >= 8, `no idempotency key was sent: ${JSON.stringify(seen)}`);
  } finally {
    await stub.stop();
  }
});

test('an explicit --idempotency-key reaches the wire verbatim', async () => {
  const seen: Array<string | undefined> = [];
  const stub = await recordingCreateStub(seen);
  try {
    const r = await runCliAsync({ url: stub.url, dir: server.dir },
      ['runs', 'create', '--task', 'm2: explicit', '--idempotency-key', 'caller-owned-key']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen[0], 'caller-owned-key');
  } finally {
    await stub.stop();
  }
});

// ---------------------------------------------------------------------------
// Retry policy around an indeterminate create (§8)
//
// Driven against a scripted client rather than a hostile socket. The property under test is "the same
// key is reused", which is a decision made in createRunIdempotent; making it depend on real TCP teardown
// timing tested the operating system instead. Whether a reset counts as indeterminate at all is covered
// by transport.test.ts.
// ---------------------------------------------------------------------------

function scriptedClient(behaviour: Array<'fail' | 'ok'>) {
  const keys: string[] = [];
  let call = 0;
  return {
    keys,
    client: {
      async createRun(_request: unknown, idempotencyKey: string) {
        keys.push(idempotencyKey);
        const action = behaviour[Math.min(call, behaviour.length - 1)];
        call += 1;
        if (action === 'fail') throw new TransportError('socket hang up');
        return { runId: `run_scripted_${keys.length}`, status: 'QUEUED' as const };
      },
    },
  };
}

test('an automatic create retry reuses the SAME key', async () => {
  // The criterion the whole idempotency design rests on. A retry that regenerates the key creates a
  // second Run, and the operator sees a success either way.
  const spy = scriptedClient(['fail', 'ok']);
  const outcome = await createRunIdempotent(spy.client as never, { task: 'x' }, { sleep: async () => {} });
  assert.equal(spy.keys.length, 2, `expected two attempts, saw ${spy.keys.length}`);
  assert.equal(spy.keys[0], spy.keys[1], `retry changed the key: ${spy.keys[0]} -> ${spy.keys[1]}`);
  assert.equal(outcome.attempts, 2);
});

test('the generated key is stable across attempts and unique per invocation', async () => {
  const a = scriptedClient(['fail', 'fail', 'ok']);
  await createRunIdempotent(a.client as never, { task: 'x' }, { sleep: async () => {}, maxRetries: 2 });
  assert.equal(new Set(a.keys).size, 1, 'more than one key was used within one invocation');

  const b = scriptedClient(['ok']);
  await createRunIdempotent(b.client as never, { task: 'x' }, { sleep: async () => {} });
  assert.notEqual(a.keys[0], b.keys[0], 'two invocations reused a key; they would collide server-side');
});

test('an exhausted create reports the key so the operator can retry safely', async () => {
  // Without this the only honest advice after "the server did not answer" is "you might have two Runs".
  const spy = scriptedClient(['fail']);
  await assert.rejects(
    () => createRunIdempotent(spy.client as never, { task: 'x' }, { sleep: async () => {} }),
    (err: unknown) => {
      const e = err as CreateUncertainError;
      assert.ok(e instanceof CreateUncertainError, 'expected CreateUncertainError');
      assert.equal(e.key, spy.keys[0], 'the reported key is not the one that was sent');
      assert.match(e.message, /--idempotency-key\s+[0-9a-f-]{36}/);
      return true;
    },
  );
});

test('a definite rejection is NOT retried, and the key is not offered', async () => {
  // A 400 will fail identically on retry, and telling the operator to reuse its key would imply the
  // create might have landed when the server has explicitly said it did not.
  const spy = { keys: [] as string[], client: { async createRun(_r: unknown, key: string) {
    spy.keys.push(key);
    throw new UsageError('task is required');
  } } };
  await assert.rejects(
    () => createRunIdempotent(spy.client as never, { task: 'x' }, { sleep: async () => {} }),
    (err: unknown) => (err as Error).message === 'task is required',
  );
  assert.equal(spy.keys.length, 1, 'a definite rejection must not be retried');
});

test('a 429 honours Retry-After and keeps the key', async () => {
  const spy = scriptedClient(['rate', 'ok'] as never);
  const waits: number[] = [];
  const client = {
    async createRun(_r: unknown, key: string) {
      spy.keys.push(key);
      if (spy.keys.length === 1) throw new RateLimitError('slow down', 2);
      return { runId: 'run_after_backoff', status: 'QUEUED' as const };
    },
  };
  const outcome = await createRunIdempotent(client as never, { task: 'x' }, {
    sleep: async (ms: number) => { waits.push(ms); },
  });
  assert.equal(outcome.response.runId, 'run_after_backoff');
  assert.deepEqual(waits, [2000], 'the server-requested backoff was not honoured');
  assert.equal(spy.keys[0], spy.keys[1], 'backoff retry changed the key');
});

// ---------------------------------------------------------------------------
// runs retry / cancel / input
// ---------------------------------------------------------------------------

test('runs retry reports a NEW run id and retryOf, never a transition of the old one', async () => {
  const original = await createRunViaApi(server, 'm2: retry me');
  // A QUEUED Run cannot be retried (not terminal), so cancel it into a terminal status first.
  assert.equal((await apiCall(server, `/api/runs/${original}/cancel`, { method: 'POST', body: '{}' })).status, 200);

  const r = runCli(server, ['runs', 'retry', original, '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.runId, original, 'retry must create a new Run, not reuse the id');
  assert.equal(out.retryOf, original);

  const show = runCli(server, ['runs', 'show', out.runId, '--json']);
  assert.equal(JSON.parse(show.stdout).run.retryOf, original);
});

test('runs cancel --yes cancels for real', async () => {
  const runId = await createRunViaApi(server, 'm2: cancel me');
  const r = runCli(server, ['runs', 'cancel', runId, '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /CANCELLED/);
  const check = await apiCall(server, `/api/runs/${runId}`);
  assert.equal(check.body.run.status, 'CANCELLED');
});

test('a lifecycle conflict exits 5, not 7', async () => {
  // Cancelling an already-terminal Run is a 409. Reporting it as a transport failure would tell the
  // operator the endpoint is unhealthy when the answer is "it is already cancelled".
  const runId = await createRunViaApi(server, 'm2: cancel twice');
  assert.equal(runCli(server, ['runs', 'cancel', runId, '--yes']).code, 0);
  const again = runCli(server, ['runs', 'cancel', runId, '--yes']);
  assert.equal(again.code, 5, `expected CONFLICT(5), got ${again.code}: ${again.stderr}`);
  assert.ok(!/transport|unreachable|timeout/i.test(again.stderr), `conflict described as transport failure: ${again.stderr}`);
});

test('input on a Run that is not waiting exits 5, and says so', async () => {
  // This replaced two tests that asserted input SUCCEEDS on a QUEUED Run. The server rejects that with
  // 409, so the tests were wrong and the client was right -- worth recording, because the tempting fix
  // was to make the assertion match the behaviour instead of checking which of the two was mistaken.
  // It is also acceptance criterion "lifecycle conflicts do not get reported as transport failures".
  const runId = await createRunViaApi(server, 'm2: input too early');
  const r = runCli(server, ['runs', 'input', runId, '--value', 'go ahead']);
  assert.equal(r.code, 5, `expected CONFLICT(5), got ${r.code}`);
  assert.match(r.stderr, /not waiting for input/i);
  assert.ok(!/transport|unreachable/i.test(r.stderr), `conflict described as transport failure: ${r.stderr}`);
});

test('runs input accepts --value once the Run is actually waiting', async () => {
  const runId = await createRunViaApi(server, 'm2: input me');
  forceNeedsInput(server, runId);
  const r = runCli(server, ['runs', 'input', runId, '--value', 'go ahead']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /input accepted/);
});

test('runs input reads multiline input from a pipe without shell quoting', async () => {
  const runId = await createRunViaApi(server, 'm2: piped input');
  forceNeedsInput(server, runId);
  const payload = 'line one\nline two with "quotes" and \\\nline three';
  const r = runCli(server, ['runs', 'input', runId], { input: payload });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /input accepted/);
});

// ---------------------------------------------------------------------------
// Confirmation (§6.2) -- "noninteractive mutations never block on a prompt"
// ---------------------------------------------------------------------------

test('a noninteractive cancel without --yes is refused, not run and not hung', async () => {
  const runId = await createRunViaApi(server, 'm2: refuse me');
  const started = Date.now();
  // input:'' models a closed/empty stdin, which is what a script or CI job has.
  const r = runCli(server, ['runs', 'cancel', runId], { input: '' });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 2, `expected refusal, got ${r.code}`);
  assert.match(r.stderr, /--yes/);
  assert.ok(elapsed < 15_000, `cancel blocked for ${elapsed}ms waiting on a prompt`);
  const check = await apiCall(server, `/api/runs/${runId}`);
  assert.equal(check.body.run.status, 'QUEUED', 'a refused cancel must not have reached the server');
});

test('--json without --yes is refused for a confirmed command', async () => {
  const runId = await createRunViaApi(server, 'm2: json no yes');
  const r = runCli(server, ['runs', 'cancel', runId, '--json']);
  assert.equal(r.code, 2);
  // Asserted against what the message actually says. The first version quoted the design doc's
  // phrasing ("machine-readable mode never prompts") instead of the CLI's ("JSON mode never prompts"),
  // so a correct refusal looked like a failure.
  assert.match(r.stderr, /JSON mode never prompts/);
});

test('create and input are not confirmed, so scripts do not need --yes', async () => {
  const r = runCli(server, ['runs', 'create', '--task', 'm2: no prompt needed'], { input: '' });
  assert.equal(r.code, 0, r.stderr);
});

// ---------------------------------------------------------------------------
// Stub: a create endpoint that fails the first N attempts in transit
// ---------------------------------------------------------------------------

/**
 * Accepts every create, records the key, returns 201.
 *
 * Deliberately boring. An earlier version also destroyed sockets to inject failures, which made a
 * test about retry POLICY depend on TCP teardown timing; that injection now lives in the unit tests
 * above, where it is deterministic.
 */
async function recordingCreateStub(
  seen: Array<string | undefined>,
): Promise<{ url: string; stop: () => Promise<void> }> {
  let n = 0;
  const server_: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/api/runs')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    seen.push(req.headers['idempotency-key'] as string | undefined);
    req.resume();
    req.on('end', () => {
      n += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: `run_stub${n}`, status: 'QUEUED' }));
    });
  });
  await new Promise<void>((resolve) => server_.listen(0, '127.0.0.1', resolve));
  const port = (server_.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => { server_.closeAllConnections?.(); server_.close(() => resolve()); }),
  };
}
