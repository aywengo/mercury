import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isExcluded,
  isTrusted,
  priorityRank,
  readyActorsFor,
  selectLadder,
  type Candidate,
  type GhIssue,
  type LabelEvent,
} from '../.agents/skills/nightly/select.ts';

// Recorded-shape fixtures (fields the selector actually reads; the rest omitted).
function issue(over: Partial<GhIssue> & { number: number }): GhIssue {
  return { title: `issue ${over.number}`, user: { login: 'someone' }, labels: [], created_at: '2026-09-20T00:00:00Z', ...over } as GhIssue;
}
function labeled(actor: string, label: string): LabelEvent {
  return { event: 'labeled', actor: { login: actor }, label: { name: label } };
}
function cand(i: GhIssue, timeline: LabelEvent[] = []): Candidate {
  return { issue: i, readyByTrusted: readyActorsFor(i, timeline).includes('aywengo') };
}

const TERMINAL = { e2eRunTerminal: true };

test('an issue by another author is never chosen (trust rule §5)', () => {
  const c = [cand(issue({ number: 1, user: { login: 'random-dev' } }))];
  const s = selectLadder(c, TERMINAL);
  assert.notEqual(s.issue, 1);
  assert.equal(s.rung === 'none' || s.rung === 3, true);
});

test('a nightly:ready label applied by another actor is ignored; by @aywengo it is trusted', () => {
  const other = issue({ number: 2, labels: [{ name: 'nightly:ready' }] });
  const self = issue({ number: 3, labels: [{ name: 'nightly:ready' }] });
  const tOther = [labeled('random-dev', 'nightly:ready')];
  const tSelf = [labeled('aywengo', 'nightly:ready'), labeled('random-dev', 'nightly:ready')];
  const s = selectLadder([cand(other, tOther), cand(self, tSelf)], TERMINAL);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 3, 'only the @aywengo-applied ready label counts');
  // The other-labeled issue alone: not rung 1.
  const s2 = selectLadder([cand(other, tOther)], TERMINAL);
  assert.notEqual(s2.issue, 2);
});

test('origin:e2e is trusted regardless of author', () => {
  const c = [cand(issue({ number: 4, user: { login: 'mercury-bot[bot]' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-21T00:00:00Z' }))];
  const s = selectLadder(c, TERMINAL);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 4);
  assert.match(s.reason, /origin:e2e/);
});

test('rung 1 orders by priority label then age', () => {
  const old_low = issue({ number: 10, labels: [{ name: 'origin:e2e' }, { name: 'priority: low' }], created_at: '2026-09-10T00:00:00Z' });
  const new_high = issue({ number: 11, labels: [{ name: 'origin:e2e' }, { name: 'priority: high' }], created_at: '2026-09-24T00:00:00Z' });
  const old_none = issue({ number: 12, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-11T00:00:00Z' });
  const s = selectLadder([cand(old_low), cand(new_high), cand(old_none)], TERMINAL);
  assert.equal(s.issue, 11, 'high priority beats older low/no-priority');
  const s2 = selectLadder([cand(old_low), cand(old_none)], TERMINAL);
  assert.equal(s2.issue, 10, 'low has a priority rank; absent priority sorts last');
  const same_pri_old = issue({ number: 13, labels: [{ name: 'origin:e2e' }, { name: 'priority: high' }], created_at: '2026-09-12T00:00:00Z' });
  const s3 = selectLadder([cand(new_high), cand(same_pri_old)], TERMINAL);
  assert.equal(s3.issue, 13, 'same priority: oldest first');
});

test('excluded labels (in-progress, blocked, proposed) skip the issue', () => {
  for (const label of ['nightly:in-progress', 'nightly:blocked', 'nightly:proposed']) {
    const c = [cand(issue({ number: 20, user: { login: 'aywengo' }, labels: [{ name: label }] }))];
    const s = selectLadder(c, TERMINAL);
    assert.notEqual(s.issue, 20, `${label} must not be selected`);
  }
  const c2 = [cand(issue({ number: 21, user: { login: 'aywengo' }, labels: [{ name: 'nightly:blocked' }, { name: 'priority: high' }] }))];
  const s2 = selectLadder(c2, TERMINAL);
  assert.notEqual(s2.issue, 21);
});

test('rung 2: a new @aywengo issue with no labels, oldest first', () => {
  const a = issue({ number: 30, user: { login: 'aywengo' }, created_at: '2026-09-22T00:00:00Z' });
  const b = issue({ number: 31, user: { login: 'aywengo' }, created_at: '2026-09-23T00:00:00Z' });
  const s = selectLadder([cand(b), cand(a)], TERMINAL);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 30, 'rung 1 empty, oldest first');
  // A labeled @aywengo issue is NOT rung 2 (labels mean someone triaged it).
  const labeled_ay = issue({ number: 32, user: { login: 'aywengo' }, labels: [{ name: 'bug' }] });
  const s2 = selectLadder([cand(labeled_ay)], TERMINAL);
  assert.notEqual(s2.issue, 32);
});

test('rung 1 waits until tonight\'s nightly-e2e Run is terminal', () => {
  const c = cand(issue({ number: 40, labels: [{ name: 'origin:e2e' }] }));
  const s = selectLadder([c], { e2eRunTerminal: false });
  assert.notEqual(s.issue, 40, 'e2e verdict still open: rung 1 does not offer work');
  // Rung 2 still works while e2e is open.
  const ay = issue({ number: 41, user: { login: 'aywengo' } });
  const s2 = selectLadder([c, cand(ay)], { e2eRunTerminal: false });
  assert.equal(s2.rung, 2);
  assert.equal(s2.issue, 41);
});

test('rung 3 / none', () => {
  const s = selectLadder([cand(issue({ number: 50, user: { login: 'random' }, labels: [{ name: 'question' }] }))], TERMINAL);
  assert.equal(s.rung, 3, 'untrusted issues exist but nothing eligible: docs → proposals rung');
  const s2 = selectLadder([], TERMINAL);
  assert.equal(s2.rung, 'none');
});

test('isTrusted / isExcluded / priorityRank unit behavior', () => {
  assert.equal(isTrusted(issue({ number: 1, user: { login: 'aywengo' } }), false), true);
  assert.equal(isTrusted(issue({ number: 2, user: { login: 'x' }, labels: [{ name: 'origin:e2e' }] }), false), true);
  assert.equal(isTrusted(issue({ number: 3, user: { login: 'x' } }), true), true, 'ready-by-trusted flag');
  assert.equal(isTrusted(issue({ number: 4, user: { login: 'x' } }), false), false);
  assert.equal(isExcluded(issue({ number: 5, labels: [{ name: 'nightly:in-progress' }] })), true);
  assert.equal(priorityRank(issue({ number: 6, labels: [{ name: 'priority: high' }] })), 0);
  assert.equal(priorityRank(issue({ number: 7, labels: [{ name: 'priority: low' }] })), 2);
  assert.equal(priorityRank(issue({ number: 8 })), 3);
});

test('readyActorsFor reads only labeled events for the ready label', () => {
  const events: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', actor: { login: 'x' }, label: { name: 'bug' } },
    { event: 'unlabeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'closed', actor: { login: 'aywengo' } },
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 9 }), events), ['aywengo']);
});


test('runSelectorWith claims the chosen issue BEFORE returning, and re-selects on a racer', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const events: string[] = [];
  const issues: Record<number, GhIssue> = {
    60: issue({ number: 60, user: { login: 'aywengo' } }),
    61: issue({ number: 61, user: { login: 'aywengo' } }),
  };
  // Re-reads report the label as present (the claim landed), so the selector re-selects.
  const io = {
    async get(path: string) {
      events.push(`get ${path}`);
      const m = /issues\/(\d+)$/.exec(path);
      if (m) return { ...issues[Number(m[1])!]!, labels: [{ name: 'nightly:in-progress' }] };
      return Object.values(issues);
    },
    async post(path: string) {
      events.push(`post ${path}`);
    },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  // First claim on #60, then re-select picks #61 and claims it too (also reported taken).
  assert.deepEqual(events.filter((e) => e.startsWith('post')), [
    'post /repos/aywengo/mercury/issues/60/labels',
    'post /repos/aywengo/mercury/issues/61/labels',
  ]);
  assert.equal(s.rung, 3, 'both candidates claimed: nothing left, docs rung reported');
  const firstPost = events.findIndex((e) => e.startsWith('post'));
  assert.ok(firstPost < events.length - 1, 'the claim POST happens before the decision is returned');
});

test('runSelectorWith --dry-run never posts the claim', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const posts: string[] = [];
  const io = {
    async get() { return [issue({ number: 70, user: { login: 'aywengo' } })]; },
    async post(path: string) { posts.push(path); },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.issue, 70);
  assert.deepEqual(posts, [], '--dry-run prints the decision and writes nothing');
});
