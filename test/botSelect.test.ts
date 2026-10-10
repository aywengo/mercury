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
