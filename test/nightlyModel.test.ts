// The model-endpoint preflight (#1040): a crashed model server must not cost a claim. The
// preflight answers "would a model call work right now?" as a RECORD, never an exception, and
// `next.ts run --task/--model` runs it BEFORE the ladder's claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir } from './helpers.ts';

import {
  checkModel,
  exitCodeFor,
  resolveTaskModel,
  type ModelCheckIo,
} from '../.agents/skills/nightly/model.ts';
import { runNext, ModelUnavailableError, type NextIo } from '../.agents/skills/nightly/next.ts';

const BASE = 'http://127.0.0.1:8000';
/** Spawn a CLI without blocking this process: `execFileSync` would starve the in-process test
 * server it is supposed to talk to (the request never gets answered). */
async function runCli(script: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ output: string; status: number }> {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      const status = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, status });
    });
  });
}

const MODEL = 'Qwen3.8-27B-MLX-bf16-mtp';

/** Answers per path; a thrown value simulates a transport failure (refused socket, timeout). */
function ioAnswering(answers: Record<string, { status: number; body: unknown } | Error>): ModelCheckIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchJson(url) {
      const path = url.slice(BASE.length);
      calls.push(path);
      const a = answers[path];
      if (a === undefined) throw new Error(`no answer for ${path}`);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

test('a listed model is ok', async () => {
  const io = ioAnswering({ '/admin/api/models': { status: 200, body: [{ id: MODEL, loaded: false }, { id: 'other' }] } });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, apiKey: 'k', io });
  assert.deepEqual(check, { status: 'ok', model: MODEL, endpoint: BASE });
  assert.deepEqual(io.calls, ['/admin/api/models'], 'the admin listing is authoritative; no fallback needed');
});

test('a model the server does not list is model-missing, not unreachable', async () => {
  const io = ioAnswering({ '/admin/api/models': { status: 200, body: [{ id: 'other' }] } });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, io });
  assert.equal(check.status, 'model-missing');
  assert.match(check.reason ?? '', /none named 'Qwen3\.8-27B-MLX-bf16-mtp'/);
  assert.equal(exitCodeFor(check), 2);
});

test('a refused or timed-out endpoint is unreachable, and says why', async () => {
  const refused = ioAnswering({ '/admin/api/models': Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  const a = await checkModel({ model: MODEL, baseUrl: BASE, io: refused });
  assert.equal(a.status, 'unreachable');
  assert.match(a.reason ?? '', /ECONNREFUSED/);
  assert.equal(exitCodeFor(a), 1);

  const timedOut = ioAnswering({ '/admin/api/models': Object.assign(new Error('timed out'), { name: 'TimeoutError' }) });
  const b = await checkModel({ model: MODEL, baseUrl: BASE, io: timedOut });
  assert.equal(b.status, 'unreachable');
  assert.match(b.reason ?? '', /no answer within 5000ms/);

  // No errno (undici's "bad port", a refused TLS handshake): the cause's message is the only
  // specific text there is, and repeating "fetch failed" is the unhelpful line this replaces.
  const noErrno = ioAnswering({
    '/admin/api/models': Object.assign(new Error('fetch failed'), { cause: new Error('bad port') }),
  });
  const c = await checkModel({ model: MODEL, baseUrl: BASE, io: noErrno });
  assert.equal(c.status, 'unreachable');
  assert.equal(c.reason, 'fetch failed (bad port)');
});

test('a rejected key is unauthorized, so the record names the real problem', async () => {
  // Every listing shape refuses the key: that is what unauthorized means.
  const io = ioAnswering({
    '/admin/api/models': { status: 401, body: { message: 'unauthorized' } },
    '/v1/models': { status: 401, body: { message: 'unauthorized' } },
  });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, apiKey: 'wrong', io });
  assert.equal(check.status, 'unauthorized');
  assert.match(check.reason ?? '', /401/);
});

test('a 401 on the admin routes alone does not block a server whose model routes accept the key', async () => {
  // The two route families can require different keys; treating the first 401 as final would block
  // every night against a perfectly usable server (#1040 review M2).
  const io = ioAnswering({
    '/admin/api/models': { status: 401, body: null },
    '/v1/models': { status: 200, body: { data: [{ id: MODEL }] } },
  });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, apiKey: 'k', io });
  assert.equal(check.status, 'ok');
  assert.deepEqual(io.calls, ['/admin/api/models', '/v1/models']);
});

test('a server without admin routes falls back to the OpenAI-compatible listing', async () => {
  const io = ioAnswering({
    '/admin/api/models': { status: 404, body: null },
    '/v1/models': { status: 200, body: { data: [{ id: MODEL }] } },
  });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, io });
  assert.equal(check.status, 'ok');
  assert.deepEqual(io.calls, ['/admin/api/models', '/v1/models']);
});

test('a 5xx is unreachable, and an unparseable listing is reported rather than assumed healthy', async () => {
  const five = ioAnswering({ '/admin/api/models': { status: 503, body: null } });
  assert.equal((await checkModel({ model: MODEL, baseUrl: BASE, io: five })).status, 'unreachable');

  const junk = ioAnswering({ '/admin/api/models': { status: 200, body: '<html>maintenance</html>' } });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, io: junk });
  assert.equal(check.status, 'unreachable');
  assert.match(check.reason ?? '', /returned no model list/);
});

test('the model comes from the bot task that runs it, so the pin has one home', () => {
  const dir = tempDir('nightly-model-');
  const path = join(dir, 'nightly.json');
  writeFileSync(path, JSON.stringify({
    schedule: { tasks: [
      { name: 'nightly-e2e', template: { model: 'small' } },
      { name: 'nightly-next', template: { model: MODEL } },
    ] },
  }));
  assert.equal(resolveTaskModel('nightly-next', { configPath: path }), MODEL);
  assert.throws(() => resolveTaskModel('nightly-report', { configPath: path }), /no task named 'nightly-report'/);

  const noPin = join(dir, 'unpinned.json');
  writeFileSync(noPin, JSON.stringify({ schedule: { tasks: [{ name: 'nightly-next', template: {} }] } }));
  assert.throws(() => resolveTaskModel('nightly-next', { configPath: noPin }), /pins no model/);
});

/** An io that records every call, so a test can prove the ladder never ran. */
function recordingIo(): NextIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path) { calls.push(`GET ${path}`); return { body: [], status: 200, link: null }; },
    async post(path) { calls.push(`POST ${path}`); return { body: {}, status: 201 }; },
    async postLabel(path) { calls.push(`LABEL ${path}`); return true; },
    async deleteLabel(path) { calls.push(`UNLABEL ${path}`); return true; },
  };
}

test('a dead model server claims NOTHING: the ladder never runs', async () => {
  const io = recordingIo();
  const record = { status: 'unreachable' as const, model: MODEL, endpoint: BASE, reason: 'ECONNREFUSED' };
  await assert.rejects(
    runNext(io, { GH_TOKEN: 't' }, { repo: 'aywengo/mercury', dryRun: false, model: MODEL, checkModel: async () => record }),
    (e: unknown) => e instanceof ModelUnavailableError && e.record.status === 'unreachable',
  );
  assert.deepEqual(io.calls, [], 'no read, and above all no claim, before the model answers');
});

test('a healthy model lets the ladder run, and the check happens first', async () => {
  const io = recordingIo();
  let callsAtCheck = -1;
  const sel = await runNext(io, { GH_TOKEN: 't' }, {
    repo: 'aywengo/mercury',
    dryRun: true,
    model: MODEL,
    // Asserted INSIDE the seam: reading io.calls after runNext resolves cannot distinguish "the
    // check ran first" from "the check ran last" (#1040 review).
    checkModel: async () => {
      callsAtCheck = io.calls.length;
      return { status: 'ok', model: MODEL, endpoint: BASE };
    },
  });
  assert.equal(callsAtCheck, 0, 'no GitHub call happens before the model answers');
  assert.equal(sel.rung, 'none');
  assert.ok(io.calls.length > 0, 'and the ladder still runs when the model is healthy');
});

test('no --model/--task keeps the preflight out of the way', async () => {
  const io = recordingIo();
  let checked = false;
  const sel = await runNext(io, { GH_TOKEN: 't' }, {
    repo: 'aywengo/mercury',
    dryRun: true,
    checkModel: async () => { checked = true; return { status: 'ok', model: MODEL, endpoint: BASE }; },
  });
  assert.equal(sel.rung, 'none');
  assert.equal(checked, false);
});

// ---- the CLI, spawned for real: the exit codes are the contract the nightly Run reads ----

test('model.ts CLI: exit codes and the --bot-config seam', async () => {
  const { createServer } = await import('node:http');
  const script = new URL('../.agents/skills/nightly/model.ts', import.meta.url).pathname;

  // A real endpoint, so the success path is exercised end to end (listing shape + auth header).
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.url === '/admin/api/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: MODEL, loaded: true }]));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const dir = tempDir('nightly-model-cli-');
  const configPath = join(dir, 'nightly.json');
  writeFileSync(configPath, JSON.stringify({ schedule: { tasks: [{ name: 'nightly-next', template: { model: MODEL } }] } }));

  const run = (args: string[], extraEnv: Record<string, string> = {}) => runCli(script, args, extraEnv);

  try {
    const ok = await run(['check', '--task', 'nightly-next', '--bot-config', configPath, '--base-url', base, '--api-key', 'k']);
    assert.equal(ok.status, 0, ok.output);
    assert.deepEqual(JSON.parse(ok.output.trim().split('\n')[0]), { status: 'ok', model: MODEL, endpoint: base });
    assert.equal(seen[0], 'Bearer k', 'the key reaches the request as a bearer token');

    // The pin comes from the config, so a task the file does not have is a usage failure (64), not a
    // silent "ok" against whatever model happens to be loaded.
    const unknownTask = await run(['check', '--task', 'nightly-report', '--bot-config', configPath, '--base-url', base]);
    assert.equal(unknownTask.status, 64);
    assert.match(unknownTask.output, /no task named 'nightly-report'/);

    const missing = await run(['check', '--model', 'nope', '--base-url', base]);
    assert.equal(missing.status, 2, 'a model the server does not list');
    assert.equal(JSON.parse(missing.output.trim().split('\n')[0]).status, 'model-missing');

    // A closed port: the record must still be printed (it is the Run's only evidence).
    const dead = await run(['check', '--model', MODEL, '--base-url', 'http://127.0.0.1:8999']);
    assert.equal(dead.status, 1);
    assert.equal(JSON.parse(dead.output.trim().split('\n')[0]).status, 'unreachable');

    const noModel = await run(['check', '--base-url', base]);
    assert.equal(noModel.status, 64);
    assert.match(noModel.output, /--task <bot task>.*or --model/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('next.ts CLI: the preflight is ON by default and claims nothing when the model is down', async () => {
  const script = new URL('../.agents/skills/nightly/next.ts', import.meta.url).pathname;
  const dir = tempDir('nightly-next-cli-');
  const configPath = join(dir, 'nightly.json');
  writeFileSync(configPath, JSON.stringify({ schedule: { tasks: [{ name: 'nightly-next', template: { model: MODEL } }] } }));
  // No GH_TOKEN: if the ladder ran, it would fail on the token, not on the model. The model record in
  // the output is what proves the preflight came first -- and that it runs BEFORE the transport.
  const run = (args: string[]) => runCli(script, args, { GH_TOKEN: '', OMLX_BASE_URL: 'http://127.0.0.1:8999' });

  // No --task, no --model: the default is still the guard (review M1).
  const blocked = await run(['run', '--repo', 'aywengo/mercury', '--bot-config', configPath]);
  assert.equal(blocked.status, 1, blocked.output);
  const record = JSON.parse(blocked.output.split('\n')[0]);
  assert.equal(record.status, 'unreachable');
  assert.match(blocked.output, /nothing claimed/);

  // --skip-model-check is the explicit way out; the run then reaches the ladder (and fails on the
  // missing token, which is a different, non-model error).
  const skipped = await run(['run', '--repo', 'aywengo/mercury', '--skip-model-check']);
  assert.notEqual(skipped.status, 0);
  assert.doesNotMatch(skipped.output, /"status":"unreachable"/);
});
