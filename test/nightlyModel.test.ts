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
  const io = ioAnswering({ '/admin/api/models': { status: 401, body: { message: 'unauthorized' } } });
  const check = await checkModel({ model: MODEL, baseUrl: BASE, apiKey: 'wrong', io });
  assert.equal(check.status, 'unauthorized');
  assert.match(check.reason ?? '', /401/);
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
  assert.equal(resolveTaskModel('nightly-next', path), MODEL);
  assert.throws(() => resolveTaskModel('nightly-report', path), /no task named 'nightly-report'/);

  const noPin = join(dir, 'unpinned.json');
  writeFileSync(noPin, JSON.stringify({ schedule: { tasks: [{ name: 'nightly-next', template: {} }] } }));
  assert.throws(() => resolveTaskModel('nightly-next', noPin), /pins no model/);
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
  const order: string[] = [];
  const sel = await runNext(io, { GH_TOKEN: 't' }, {
    repo: 'aywengo/mercury',
    dryRun: true,
    model: MODEL,
    checkModel: async () => { order.push('check'); return { status: 'ok', model: MODEL, endpoint: BASE }; },
  });
  order.push(...io.calls.slice(0, 1));
  assert.equal(sel.rung, 'none');
  assert.equal(order[0], 'check', 'the preflight is the first thing that happens');
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
