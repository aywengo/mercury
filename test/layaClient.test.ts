/**
 * The Laya client contract (docs/laya-integration-design.md §5.2 and §11, issue #825).
 *
 * Every §11 fake scenario yields its documented outcome. The planted-secret regression test is the
 * fails-on-base proof: on base (no client, no redaction-before-send) there is nothing to pass it,
 * and dropping the redaction call in `buildLayaState` makes it fail (mutation-checked).
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { LayaClient, buildLayaState, validateLayaBody, DEFAULT_TIMEOUT_MS } from '../src/laya/client.ts';
import { startFakeLaya, validPick, type FakeLaya } from './support/fakeLaya.ts';
import { createRedactor, type Redactor } from '../src/domain/redact.ts';

const fakes: FakeLaya[] = [];
after(async () => { for (const f of fakes) await f.close(); });

async function withFake(script: Parameters<typeof startFakeLaya>[0], apiKey = 'laya-key'): Promise<FakeLaya> {
  const f = await startFakeLaya(script, { apiKey });
  fakes.push(f);
  return f;
}

function client(baseUrl: string, opts: Partial<ConstructorParameters<typeof LayaClient>[0]> = {}): LayaClient {
  return new LayaClient({ baseUrl, apiKey: 'laya-key', secrets: ['hush-hush'], ...opts });
}

const OPTIONS = [
  { key: 'A', describe: 'hard multi-file changes' },
  { key: 'B', describe: 'routine bug fixes' },
  { key: 'C', describe: 'cheap mechanical edits' },
];
const STATE = { task: 'Fix the flaky test', template: 'nightly', repository: '/tmp/repo', skills: ['git-pr'] };

test('valid pick: ok:true carries answers, checkpoint, latencyMs', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  if (res.ok) {
    assert.equal(res.checkpoint, 'english');
    assert.equal(res.answers.length, 1, 'the sidecar answers the question with ONE choice row');
    assert.equal(res.answers[0].key, 'A');
    assert.equal(res.answers[0].choice, 'A');
    assert.ok(res.answers[0].probability > 0, 'the calibrated answer_confidence is projected');
    assert.equal(typeof res.latencyMs, 'number');
    assert.ok(res.latencyMs >= 0);
  }
  // The request the fake received: the 0.3.25 wire shape (state + questions), bearer auth,
  // the /v1/systemone path. The §6.3 allowlist fields ride in the question's instructions.
  assert.equal(f.received.length, 1);
  const body = f.received[0].body as { state: string; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
  assert.deepEqual(Object.keys(body).sort(), ['questions', 'state'], 'request carries only state+questions');
  const q = body.questions['mercury-dispatch'];
  assert.ok(q, 'the single keyed question is present');
  assert.equal(q.type, 'choice');
  assert.deepEqual(q.criteria, { A: 'hard multi-file changes', B: 'routine bug fixes', C: 'cheap mechanical edits' });
  assert.ok(q.instructions.includes('template=nightly'), 'template rides in instructions');
  assert.ok(q.instructions.includes('repository=repo'), 'repository basename rides in instructions');
  assert.ok(q.instructions.includes('skills=git-pr'), 'skills ride in instructions');
  assert.ok(f.received[0].headers.authorization === 'Bearer laya-key');
});

test('below-threshold is the CALLER\'s decision: the client reports the pick, not a verdict', async () => {
  // §6.4 gates on answer_confidence at the dispatcher layer; the client's job is honest transport.
  // A low-but-finite probability is still a valid answer (0 is finite).
  const f = await withFake([{ json: { model: 'english', answers: { 'mercury-dispatch': { type: 'choice', choice: 'B', probabilities: { A: 0, B: 0, C: 1 }, confidence: 0.1, answer_confidence: 0 } } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.answers[0].probability, 0);
});

test('unoffered answer key -> ok:false reason choice_not_offered (§11 option key not offered)', async () => {
  const f = await withFake([{ json: { model: 'english', answers: { 'mercury-dispatch': { type: 'choice', choice: 'Z', probabilities: {}, confidence: 0.9, answer_confidence: 0.9 } } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'choice_not_offered' });
});

test('choice not among the offered keys -> ok:false reason choice_not_offered', async () => {
  const f = await withFake([{ json: { model: 'english', answers: { 'mercury-dispatch': { type: 'choice', choice: 'nope', probabilities: {}, confidence: 0.9, answer_confidence: 0.9 } } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'choice_not_offered' });
});

test('non-finite probability (NaN) -> ok:false reason non_finite_probability', async () => {
  // JSON cannot carry a NaN literal, so a NaN can only arrive from a parser that accepts it
  // (non-standard) or from the validator itself; assert the validator contract directly, and the
  // Infinity test below covers the over-the-wire path JSON CAN carry.
  const v = validateLayaBody(
    { model: 'english', answers: { 'mercury-dispatch': { type: 'choice', choice: 'A', answer_confidence: NaN } } },
    new Set(['A']),
  );
  assert.deepEqual({ ok: v.ok, reason: v.ok ? null : v.reason }, { ok: false, reason: 'non_finite_probability' });
});

test('Infinity probability -> ok:false reason non_finite_probability', async () => {
  const f = await withFake([{ rawBody: '{"model":"english","answers":{"mercury-dispatch":{"type":"choice","choice":"A","answer_confidence":1e999}}}' }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'non_finite_probability' });
});

test('over-cap body -> ok:false reason over_cap (never a truncated parse)', async () => {
  const f = await withFake([{ rawBody: '{"checkpoint":"english","answers":[],"padding":"' + 'x'.repeat(80 * 1024) + '"}' }]);
  const res = await client(f.url, { maxResponseBytes: 64 * 1024 }).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'over_cap' });
});

test('401 -> ok:false reason http_status naming the status', async () => {
  const f = await withFake([{ status: 401, json: { error: 'unauthorized' } }]);
  const res = await client(f.url, { apiKey: 'wrong-key' }).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'http_status' });
  if (!res.ok) assert.match(res.detail ?? '', /401/);
});

test('timeout -> ok:false reason timeout within the configured deadline', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']), delayMs: 2_000 }]);
  const t0 = Date.now();
  const res = await client(f.url, { timeoutMs: 120 }).ask({ options: OPTIONS }, STATE);
  const elapsed = Date.now() - t0;
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'timeout' });
  assert.ok(elapsed < 1_500, `deadline enforced (took ${elapsed}ms)`);
});

test('malformed body (not JSON) -> ok:false reason malformed', async () => {
  const f = await withFake([{ rawBody: '<html>not json</html>' }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'malformed' });
});

test('malformed body (wrong shape) -> ok:false reason malformed', async () => {
  const f = await withFake([{ json: { unexpected: true } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'malformed' });
});

test('connection refused -> ok:false reason unreachable', async () => {
  // Port 1 on loopback: nothing listens there.
  const res = await client('http://127.0.0.1:1').ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'unreachable' });
});

test('empty answers object -> ok:false reason unknown_answer_key (the question was not answered)', async () => {
  const f = await withFake([{ json: { model: 'english', answers: {} } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'unknown_answer_key' });
});

test('a response answering a DIFFERENT question id -> ok:false reason unknown_answer_key (#837 r5)', async () => {
  const f = await withFake([{ json: { model: 'english', answers: { 'some-other-question': { type: 'choice', choice: 'A', answer_confidence: 0.9 } } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'unknown_answer_key' });
});

test('an answers row that is an ARRAY (not the 0.3.25 object shape) -> ok:false reason malformed', async () => {
  // Pins the r4/r5 fix: the earlier draft accepted array rows; a real laya-serve answer is an
  // object. The mutation check (accepting arrays again) fails this test.
  const f = await withFake([{ json: { model: 'english', answers: { 'mercury-dispatch': [{ type: 'choice', choice: 'A', answer_confidence: 0.9 }] } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'malformed' });
});

test('a non-choice answer type -> ok:false reason malformed', async () => {
  const f = await withFake([{ json: { model: 'english', answers: { 'mercury-dispatch': { type: 'noul', noul: 0.6 } } } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'malformed' });
});

test('more than 12 options -> refused locally, no request leaves the process', async () => {
  const f = await withFake([{ json: validPick(['A']) }]);
  const tooMany = Array.from({ length: 13 }, (_, i) => ({ key: String(i), describe: 'x' }));
  const res = await client(f.url).ask({ options: tooMany }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'malformed' });
  assert.equal(f.received.length, 0, 'no sidecar round-trip');
});

test('REGRESSION: a secret planted in the task never reaches the sidecar (fails if redaction is skipped)', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const res = await client(f.url).ask(
    { options: OPTIONS },
    { ...STATE, task: 'token is hush-hush inside this task text' },
  );
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  const sent = String((f.received[0].body as { state: string }).state);
  assert.ok(!sent.includes('hush-hush'), `secret leaked to the sidecar: ${sent}`);
  assert.ok(sent.includes('[REDACTED]'), `expected the redacted form, got: ${sent}`);
});

test('REGRESSION: the redactor covers EVERY state field, not just task (#837 r1)', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const res = await client(f.url).ask(
    { options: OPTIONS },
    {
      task: 'clean task',
      template: 'deploy-hush-hush',
      repository: '/repos/hush-hush',
      skills: ['deploy-hush-hush'],
    },
  );
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  const body = f.received[0].body as { state: string; questions: Record<string, { instructions: string }> };
  const instructions = body.questions['mercury-dispatch']?.instructions ?? '';
  assert.ok(!instructions.includes('hush-hush'), `template/skills leaked via instructions: ${instructions}`);
  assert.ok(!body.state.includes('hush-hush'), `state leaked: ${body.state}`);
});

test('REGRESSION: a repository URL with query/fragment keeps only the pathname basename (#837 r2)', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const res = await client(f.url).ask(
    { options: OPTIONS },
    { ...STATE, repository: 'https://user:token@host/org/repo.git?sig=abc123#frag' },
  );
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  const body = f.received[0].body as { state: string; questions: Record<string, { instructions: string }> };
  const instructions = body.questions['mercury-dispatch']?.instructions ?? '';
  const sentRepo = instructions.match(/repository=(\S+)/)?.[1] ?? '';
  assert.equal(sentRepo, 'repo.git', `unexpected repository value: ${sentRepo}`);
  assert.ok(!sentRepo.includes('sig='), 'query survived');
  assert.ok(!sentRepo.includes('token'), 'URL credentials survived');
  assert.ok(!sentRepo.includes('frag'), 'fragment survived');
  assert.ok(!body.state.includes('sig=') && !body.state.includes('token'), 'nothing URL-ish in the state text');
});

test('REGRESSION: option objects are rebuilt from key+describe only - extra caller fields never leave (#837 r3)', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const leaky = [
    { key: 'A', describe: 'hard multi-file changes', agent: 'claude', model: 'opus', credential: 'super-secret-credential' },
    { key: 'B', describe: 'routine bug fixes', credential: 'another-secret' },
    { key: 'C', describe: 'cheap mechanical edits' },
  ] as unknown as typeof OPTIONS;
  const res = await client(f.url).ask({ options: leaky }, STATE);
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  const sent = JSON.stringify(f.received[0].body);
  assert.ok(!sent.includes('claude'), 'agent field leaked');
  assert.ok(!sent.includes('opus'), 'model field leaked');
  assert.ok(!sent.includes('super-secret-credential'), 'credential leaked');
  assert.ok(!sent.includes('another-secret'), 'second credential leaked');
});

test('redaction failure is a typed failure, not a throw past the caller', () => {
  const boom: Redactor = {
    redact: () => { throw new Error('redactor exploded'); },
    redactJson: () => { throw new Error('redactor exploded'); },
  };
  const built = buildLayaState(STATE, boom);
  assert.deepEqual({ ok: built.ok, reason: built.ok ? null : built.reason }, { ok: false, reason: 'redaction_failed' });
});

test('no retry: one call, one request, even on failure', async () => {
  const f = await withFake([{ status: 500, json: { error: 'boom' } }]);
  await client(f.url).ask({ options: OPTIONS }, STATE);
  // Give any hypothetical retry a beat.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.received.length, 1, 'exactly one request despite the failure');
});

test('deadline default is 500ms (§5.2) and the cap default is 64KiB', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 500);
  const c = new LayaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  const internals = c as unknown as { timeoutMs: number; maxResponseBytes: number };
  assert.equal(internals.timeoutMs, 500);
  assert.equal(internals.maxResponseBytes, 64 * 1024);
});
