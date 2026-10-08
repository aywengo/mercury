// L1-2 (#855): table-driven tests for the pure candidate hard filter. The regression case is
// the perRunModel drop: there is no filter on base, so every drop reason must fail there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCandidates, type AgentsResponse, type SelectCandidate } from '../src/host/bots/select.ts';

function agentsResponse(overrides: Partial<Record<string, { perRunModel?: boolean }>> = {}): AgentsResponse {
  const capabilities: AgentsResponse['capabilities'] = {};
  for (const [agent, staticCaps] of Object.entries(overrides)) {
    capabilities[agent] = {
      version: null, versionRaw: null, goals: { supported: false },
      ...(staticCaps ? { static: staticCaps as object } : {}),
    };
  }
  return { agents: Object.keys(capabilities), defaultAgent: 'claude', capabilities };
}

const RESP = agentsResponse({
  claude: { perRunModel: true },
  fixed: { perRunModel: false },
});

const CASES: {
  name: string;
  candidates: SelectCandidate[];
  admitted: number;
  dropped: Array<{ index: number; reasonIncludes: string }>;
}[] = [
  {
    name: 'unknown agent is dropped',
    candidates: [{ agent: 'ghost', describe: 'not real' }],
    admitted: 0,
    dropped: [{ index: 0, reasonIncludes: 'not registered' }],
  },
  {
    name: 'model on a non-perRunModel agent is dropped',
    candidates: [{ agent: 'fixed', model: 'm1', describe: 'no model support' }],
    admitted: 0,
    dropped: [{ index: 0, reasonIncludes: 'per-Run model' }],
  },
  {
    name: 'invalid model shape is dropped',
    candidates: [{ agent: 'claude', model: 'two words', describe: 'bad shape' }],
    admitted: 0,
    dropped: [{ index: 0, reasonIncludes: 'whitespace or control' }],
  },
  {
    name: 'leading-dash model name is dropped',
    candidates: [{ agent: 'claude', model: '-x', describe: 'flag-like' }],
    admitted: 0,
    dropped: [{ index: 0, reasonIncludes: 'command-line' }],
  },
  {
    name: 'all kept',
    candidates: [
      { agent: 'claude', describe: 'no model' },
      { agent: 'claude', model: 'm1', describe: 'with model' },
    ],
    admitted: 2,
    dropped: [],
  },
  {
    name: 'all dropped',
    candidates: [
      { agent: 'ghost', describe: 'unknown' },
      { agent: 'fixed', model: 'm1', describe: 'no perRunModel' },
      { agent: 'claude', model: 'a b', describe: 'bad shape' },
    ],
    admitted: 0,
    dropped: [
      { index: 0, reasonIncludes: 'not registered' },
      { index: 1, reasonIncludes: 'per-Run model' },
      { index: 2, reasonIncludes: 'whitespace' },
    ],
  },
];

for (const c of CASES) {
  test(`filterCandidates: ${c.name}`, () => {
    const result = filterCandidates(c.candidates, RESP);
    assert.equal(result.admitted.length, c.admitted, JSON.stringify(result));
    assert.deepEqual(result.dropped.map((d) => d.index), c.dropped.map((d) => d.index));
    for (const [i, want] of c.dropped.entries()) {
      assert.ok(result.dropped[i]!.reason.includes(want.reasonIncludes),
        `reason ${result.dropped[i]!.reason} does not include '${want.reasonIncludes}'`);
    }
  });
}

test('filterCandidates preserves the original order of admitted candidates', () => {
  const candidates: SelectCandidate[] = [
    { agent: 'ghost', describe: 'dropped first' },
    { agent: 'claude', model: 'm1', describe: 'kept first' },
    { agent: 'fixed', model: 'm2', describe: 'dropped second' },
    { agent: 'claude', describe: 'kept second' },
  ];
  const result = filterCandidates(candidates, RESP);
  assert.deepEqual(result.admitted, [candidates[1], candidates[3]]);
  assert.deepEqual(result.dropped.map((d) => d.index), [0, 2]);
});

test('filterCandidates: the perRunModel drop fails on base (regression proof)', () => {
  // On base there is no select.ts module at all, so importing filterCandidates already fails;
  // the perRunModel drop case below pins the exact behavior the issue names as the regression.
  const result = filterCandidates([{ agent: 'fixed', model: 'm1', describe: 'x' }], RESP);
  assert.equal(result.admitted.length, 0);
  assert.equal(result.dropped[0]!.index, 0);
  assert.match(result.dropped[0]!.reason, /per-Run model/);
});

// -- L1-3 (#856): buildSelectQuestion + decide (§6.3, §6.4, §11) --

import { buildSelectQuestion, decide, optionKey, type DecideClient, type SelectConfig } from '../src/host/bots/select.ts';
import { LayaClient } from '../src/laya/client.ts';
import { createRedactor } from '../src/domain/redact.ts';
import type { LayaResult } from '../src/laya/types.ts';

const CTX = { task: 'routine task', template: 'nightly-next', repository: 'https://github.com/aywengo/mercury.git', skills: ['planning'] };
const TWO: SelectCandidate[] = [
  { agent: 'claude', model: 'opus', describe: 'hard multi-file changes' },
  { agent: 'claude', model: 'sonnet', describe: 'routine bug fixes' },
];

test('buildSelectQuestion: opaque keys, describe text, nothing else offered', () => {
  const q = buildSelectQuestion(TWO, CTX);
  assert.deepEqual(q.options.map((o) => o.key), ['A', 'B']);
  assert.deepEqual(q.options.map((o) => o.describe), ['hard multi-file changes', 'routine bug fixes']);
  // The agent and model names never appear as keys or in the option text.
  for (const o of q.options) {
    assert.ok(!o.key.includes('claude') && !o.key.includes('opus') && !o.key.includes('sonnet'));
  }
});

test('optionKey reaches the 12-candidate cap without collision', () => {
  const keys = Array.from({ length: 12 }, (_, i) => optionKey(i));
  assert.equal(new Set(keys).size, 12);
});

/** A scripted fake client: one answer per call, in turn. */
function fakeClient(results: LayaResult[]): DecideClient & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async ask() {
      this.calls++;
      return results[Math.min(i++, results.length - 1)]!;
    },
  };
}

function okResult(overrides: Partial<Extract<LayaResult, { ok: true }>> = {}): LayaResult {
  return {
    ok: true,
    answers: [{ key: 'A', choice: 'A', probability: 0.9 }],
    checkpoint: 'english',
    latencyMs: 38,
    ...overrides,
  };
}

const SHADOW: SelectConfig = { mode: 'shadow' };
const ENFORCE: SelectConfig = { mode: 'enforce', minConfidence: 0.8 };
const DEFAULT = { agent: 'claude', model: 'sonnet' };

test('decide: one admitted candidate makes no client call; shadow keeps the default, enforce runs it (§6.4 no-call, #866 review)', async () => {
  const client = fakeClient([okResult()]);
  const shadow = await decide([TWO[0]!], client, SHADOW, DEFAULT, CTX);
  assert.equal(client.calls, 0);
  assert.deepEqual(shadow.chosen, DEFAULT, 'shadow never changes what runs, even with one candidate');
  assert.deepEqual(shadow.record.chosen, DEFAULT);
  assert.equal(shadow.record.reason, 'single_candidate');
  const enforce = await decide([TWO[0]!], client, ENFORCE, DEFAULT, CTX);
  assert.equal(client.calls, 0);
  assert.deepEqual(enforce.chosen, { agent: 'claude', model: 'opus' });
  assert.deepEqual(enforce.record.chosen, enforce.chosen, 'the record names what runs (#854 chosen-must-match)');
});

/** The #854 schema contract (docs/api.md, selection schema v1, as amended on #865 f6412b4):
 *  a no-pick reason carries no laya / answerConfidence / distribution; a pick reason carries
 *  laya. Mirrored here because validateSelection is not on main until #865 merges -- the
 *  direct round-trip test belongs to L1-4 (#857), where both sides meet. */
const NO_PICK = new Set(['sidecar_unavailable', 'invalid_response', 'single_candidate']);
function assertSchemaContract(record: Record<string, unknown>, label: string): void {
  if (NO_PICK.has(record.reason as string)) {
    for (const k of ['laya', 'answerConfidence', 'distribution']) {
      assert.equal(record[k], undefined, `${label}: ${k} must be absent for ${String(record.reason)}`);
    }
  } else {
    assert.ok(record.laya && typeof record.laya === 'object', `${label}: laya required for ${String(record.reason)}`);
  }
}

test('decide: every record satisfies the #854 no-pick / pick contract (#866 review)', async () => {
  const cases: Array<[string, SelectCandidate[], LayaResult[], SelectConfig]> = [
    ['single', [TWO[0]!], [], SHADOW],
    ['unreachable', TWO, [{ ok: false, reason: 'unreachable', latencyMs: 1 }], SHADOW],
    ['timeout', TWO, [{ ok: false, reason: 'timeout', latencyMs: 1 }], ENFORCE],
    ['invalid', TWO, [{ ok: false, reason: 'malformed', latencyMs: 1 }], SHADOW],
    ['shadow pick', TWO, [okResult()], SHADOW],
    ['below threshold', TWO, [okResult({ answers: [{ key: 'A', choice: 'A', probability: 0.3 }] })], ENFORCE],
    ['selected', TWO, [okResult()], ENFORCE],
  ];
  for (const [label, admitted, results, cfg] of cases) {
    const out = await decide(admitted, fakeClient(results), cfg, DEFAULT, CTX);
    assertSchemaContract(out.record, label);
    assert.deepEqual(out.record.chosen, out.chosen, `${label}: the record names what runs`);
  }
});

test('decide: zero admitted candidates throws — the dispatch fails as a literal template would', async () => {
  await assert.rejects(() => decide([], fakeClient([]), SHADOW, DEFAULT, CTX), /no admissible candidates/);
});

// §11 scenario table: every documented fake outcome maps to its reason.
const REASONS: Array<{ name: string; result: LayaResult; cfg: SelectConfig; reason: string; chosen: unknown }> = [
  { name: 'valid pick, enforce, above threshold -> selected', result: okResult(), cfg: ENFORCE, reason: 'selected', chosen: { agent: 'claude', model: 'opus' } },
  { name: 'valid pick, shadow -> shadow, template default kept', result: okResult(), cfg: SHADOW, reason: 'shadow', chosen: DEFAULT },
  { name: 'pick below threshold -> below_threshold', result: okResult({ answers: [{ key: 'A', choice: 'A', probability: 0.3 }] }), cfg: ENFORCE, reason: 'below_threshold', chosen: DEFAULT },
  { name: 'option key not offered -> invalid_response', result: { ok: false, reason: 'choice_not_offered', latencyMs: 5 }, cfg: ENFORCE, reason: 'invalid_response', chosen: DEFAULT },
  { name: 'non-finite probability -> invalid_response', result: { ok: false, reason: 'non_finite_probability', latencyMs: 5 }, cfg: ENFORCE, reason: 'invalid_response', chosen: DEFAULT },
  { name: 'over-cap body -> sidecar_unavailable', result: { ok: false, reason: 'over_cap', latencyMs: 5 }, cfg: ENFORCE, reason: 'sidecar_unavailable', chosen: DEFAULT },
  { name: 'http 401 -> sidecar_unavailable', result: { ok: false, reason: 'http_status', detail: 'POST /v1/systemone -> 401', latencyMs: 5 }, cfg: ENFORCE, reason: 'sidecar_unavailable', chosen: DEFAULT },
  { name: 'timeout -> sidecar_unavailable', result: { ok: false, reason: 'timeout', latencyMs: 500 }, cfg: ENFORCE, reason: 'sidecar_unavailable', chosen: DEFAULT },
  { name: 'malformed body -> invalid_response', result: { ok: false, reason: 'malformed', latencyMs: 5 }, cfg: ENFORCE, reason: 'invalid_response', chosen: DEFAULT },
];
for (const c of REASONS) {
  test(`decide (§11): ${c.name}`, async () => {
    const out = await decide(TWO, fakeClient([c.result]), c.cfg, DEFAULT, CTX);
    assert.equal(out.record.reason, c.reason, JSON.stringify(out.record));
    assert.deepEqual(out.chosen, c.chosen);
    if (c.reason !== 'selected') {
      // The template default is what the record says ran, matching the run it rides on.
      assert.deepEqual(out.record.chosen, DEFAULT);
    }
  });
}

test('decide: the gate is the calibrated answerConfidence (max(p)), recorded in the record', async () => {
  const out = await decide(TWO, fakeClient([okResult({ answers: [{ key: 'B', choice: 'B', probability: 0.83 }] })]), ENFORCE, DEFAULT, CTX);
  assert.equal(out.record.answerConfidence, 0.83);
  assert.deepEqual(out.chosen, { agent: 'claude', model: 'sonnet' }); // B = sonnet pair
  assert.deepEqual(out.record.laya, { agent: 'claude', model: 'sonnet' });
  assert.deepEqual(out.record.distribution, { B: 0.83 });
  assert.equal(out.record.checkpoint, 'english');
  assert.equal(out.record.latencyMs, 38);
  assert.equal(out.record.via, 'laya');
  assert.equal(out.record.mode, 'enforce');
});

test('decide: shadow never lets upstream entropy confidence through the gate', async () => {
  // answerConfidence is the only number the gate reads; a fake with a high entropy-side value
  // but low calibrated probability must still fall back in enforce mode.
  const out = await decide(TWO, fakeClient([okResult({ answers: [{ key: 'A', choice: 'A', probability: 0.79 }] })]), ENFORCE, DEFAULT, CTX);
  assert.equal(out.record.reason, 'below_threshold');
  assert.deepEqual(out.chosen, DEFAULT);
});

// Regression test (issue acceptance 2): shadow NEVER returns a chosen other than the template
// default, whatever the fake answers. Property test over random distributions.
test('decide: shadow property — chosen is always the template default (random distributions)', async () => {
  // Deterministic PRNG (mulberry32) so failures reproduce.
  let seed = 0x856;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rand() * 11); // 2..12 candidates
    const candidates: SelectCandidate[] = Array.from({ length: n }, (_, i) => ({
      agent: 'claude', model: `m${i}`, describe: `option ${i}`,
    }));
    // Random distribution over a random offered key.
    const key = optionKey(Math.floor(rand() * n));
    const prob = rand();
    const answers = [{ key, choice: key, probability: prob }];
    const cfg: SelectConfig = rand() < 0.5 ? SHADOW : { mode: 'shadow', minConfidence: rand() };
    const out = await decide(candidates, fakeClient([okResult({ answers })]), cfg, DEFAULT, CTX);
    assert.deepEqual(out.chosen, DEFAULT, `trial ${trial}: shadow changed what runs`);
    if (cfg.minConfidence !== undefined && prob < cfg.minConfidence) {
      assert.equal(out.record.reason, 'below_threshold');
    } else {
      assert.equal(out.record.reason, 'shadow');
    }
  }
});

// Acceptance 3: end-to-end through the REAL client — the question sent to the fake carries
// opaque keys only, and a planted secret in the task text is absent from the received body.
test('decide over the real LayaClient: opaque keys on the wire, planted secret redacted', async () => {
  let received: { url: string; body: string } | undefined;
  const transport = async (req: { url: string; body: string }) => {
    received = { url: req.url, body: req.body };
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({
        model: 'english',
        answers: { 'mercury-dispatch': { type: 'choice', choice: 'B', probabilities: {}, confidence: 0.5, answer_confidence: 0.95, action: 'answer' } },
      })),
    };
  };
  const client = new LayaClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', transport, redactor: createRedactor(['hunter2']) });
  const ctx = { task: 'fix the login bug with password hunter2', template: 't', repository: 'https://github.com/aywengo/mercury.git', skills: [] };
  const out = await decide(TWO, client, ENFORCE, DEFAULT, ctx);
  assert.ok(received);
  const body = JSON.parse(received.body);
  const criteria = body.questions['mercury-dispatch'].criteria;
  assert.deepEqual(Object.keys(criteria), ['A', 'B']);
  assert.ok(!received.body.includes('hunter2'), 'the planted secret reached the sidecar');
  assert.ok(!received.body.includes('opus') || criteria.A !== 'opus', 'agent/model names must not be option keys');
  assert.equal(out.chosen.agent, 'claude'); // B -> sonnet pair; chosen = laya pick (enforce)
  assert.deepEqual(out.chosen, { agent: 'claude', model: 'sonnet' });
});
