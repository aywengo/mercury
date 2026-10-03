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
    assert.equal(res.answers.length, 3);
    assert.equal(res.answers[0].key, 'A');
    assert.equal(typeof res.latencyMs, 'number');
    assert.ok(res.latencyMs >= 0);
  }
  // The request the fake received: allowlist fields only, bearer auth, the /v1/systemone path.
  assert.equal(f.received.length, 1);
  const body = f.received[0].body as { question: { options: unknown[] }; state: Record<string, unknown> };
  assert.deepEqual(Object.keys(body), ['question', 'state'], 'request carries only question+state');
  assert.deepEqual(Object.keys(body.state).sort(), ['repository', 'skills', 'task', 'template'], 'state is the §6.3 allowlist');
  assert.equal(body.state.repository, 'repo', 'repository is the basename only');
  assert.ok(f.received[0].headers.authorization === 'Bearer laya-key');
});

test('below-threshold is the CALLER\'s decision: the client reports the pick, not a verdict', async () => {
  // §6.4 gates on answer_confidence at the dispatcher layer; the client's job is honest transport.
  // A low-but-finite probability is still a valid answer (0 is finite).
  const f = await withFake([{ json: { checkpoint: 'english', answers: [{ key: 'B', choice: 'B', probability: 0 }] } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.answers[0].probability, 0);
});

test('unoffered answer key -> ok:false reason unknown_answer_key', async () => {
  const f = await withFake([{ json: { checkpoint: 'english', answers: [{ key: 'Z', choice: 'A', probability: 0.9 }] } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'unknown_answer_key' });
});

test('choice not among the offered keys -> ok:false reason choice_not_offered', async () => {
  const f = await withFake([{ json: { checkpoint: 'english', answers: [{ key: 'A', choice: 'nope', probability: 0.9 }] } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'choice_not_offered' });
});

test('non-finite probability (NaN) -> ok:false reason non_finite_probability', async () => {
  // JSON cannot carry a NaN literal, so a NaN can only arrive from a parser that accepts it
  // (non-standard) or from the validator itself; assert the validator contract directly, and the
  // Infinity test below covers the over-the-wire path JSON CAN carry.
  const v = validateLayaBody(
    { checkpoint: 'english', answers: [{ key: 'A', choice: 'A', probability: NaN }] },
    new Set(['A']),
  );
  assert.deepEqual({ ok: v.ok, reason: v.ok ? null : v.reason }, { ok: false, reason: 'non_finite_probability' });
});

test('Infinity probability -> ok:false reason non_finite_probability', async () => {
  const f = await withFake([{ rawBody: '{"checkpoint":"english","answers":[{"key":"A","choice":"A","probability":1e999}]}' }]);
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

test('empty answers array -> ok:false reason empty_answers', async () => {
  const f = await withFake([{ json: { checkpoint: 'english', answers: [] } }]);
  const res = await client(f.url).ask({ options: OPTIONS }, STATE);
  assert.deepEqual({ ok: res.ok, reason: res.ok ? null : res.reason }, { ok: false, reason: 'empty_answers' });
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
  const sent = (f.received[0].body as { state: { task: string } }).state.task;
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
  const sent = f.received[0].body as { state: { template: string; repository: string; skills: string[] } };
  assert.ok(!sent.state.template.includes('hush-hush'), `template leaked: ${sent.state.template}`);
  assert.ok(!sent.state.repository.includes('hush-hush'), `repository leaked: ${sent.state.repository}`);
  assert.ok(sent.state.skills.every((s) => !s.includes('hush-hush')), `skills leaked: ${JSON.stringify(sent.state.skills)}`);
});

test('REGRESSION: a repository URL with query/fragment keeps only the pathname basename (#837 r2)', async () => {
  const f = await withFake([{ json: validPick(['A', 'B', 'C']) }]);
  const res = await client(f.url).ask(
    { options: OPTIONS },
    { ...STATE, repository: 'https://user:token@host/org/repo.git?sig=abc123#frag' },
  );
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  const sent = (f.received[0].body as { state: { repository: string } }).state.repository;
  assert.equal(sent, 'repo.git', `unexpected repository value: ${sent}`);
  assert.ok(!sent.includes('sig='), 'query survived');
  assert.ok(!sent.includes('token'), 'URL credentials survived');
  assert.ok(!sent.includes('frag'), 'fragment survived');
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
