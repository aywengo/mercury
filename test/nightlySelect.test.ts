import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isExcluded,
  isTrusted,
  issueAuthor,
  issueLabels,
  labelActorsFor,
  priorityRank,
  readyActorsFor,
  selectLadder,
  type Candidate,
  type GhIssue,
  type LabelEvent,
  type ResumeCandidate,
} from '../.agents/skills/nightly/select.ts';

// Recorded-shape fixtures (fields the selector actually reads; the rest omitted).
function issue(over: Partial<GhIssue> & { number: number }): GhIssue {
  return { title: `issue ${over.number}`, user: { login: 'someone' }, labels: [], created_at: '2026-09-20T00:00:00Z', ...over } as GhIssue;
}
function labeled(actor: string, label: string): LabelEvent {
  return { event: 'labeled', actor: { login: actor }, label: { name: label } };
}
function cand(i: GhIssue, timeline: LabelEvent[] = []): Candidate {
  return {
    issue: i,
    readyByTrusted: readyActorsFor(i, timeline).includes('aywengo'),
    e2eByNightly: issueAuthor(i) === 'mercury-nightly'
      && issueLabels(i).includes('origin:e2e')
      && labelActorsFor(timeline, 'origin:e2e').includes('mercury-nightly'),
    enhByTrusted: labelActorsFor(timeline, 'enhancement').includes('aywengo'),
  };
}
function e2eLabeled(actor: string): LabelEvent {
  return { event: 'labeled', actor: { login: actor }, label: { name: 'origin:e2e' } };
}

const TERMINAL = { e2eRunTerminal: true };

test('an issue by another author is never chosen (trust rule §5)', () => {
  const c = [cand(issue({ number: 1, user: { login: 'random-dev' } }))];
  const s = selectLadder(c, TERMINAL);
  assert.notEqual(s.issue, 1);
  assert.equal(s.rung === 'none' || s.rung === 4, true);
});

test('a nightly:ready label applied by another actor is ignored; by @aywengo it is trusted', () => {
  const other = issue({ number: 2, labels: [{ name: 'nightly:ready' }] });
  const self = issue({ number: 3, labels: [{ name: 'nightly:ready' }] });
  const tOther = [labeled('random-dev', 'nightly:ready')];
  const tSelf = [labeled('random-dev', 'nightly:ready'), labeled('aywengo', 'nightly:ready')];
  const s = selectLadder([cand(other, tOther), cand(self, tSelf)], TERMINAL);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 3, 'only the @aywengo-applied CURRENT ready label counts');
  // The other-labeled issue alone: not rung 1.
  const s2 = selectLadder([cand(other, tOther)], TERMINAL);
  assert.notEqual(s2.issue, 2);
});

test('origin:e2e is trusted only from the nightly identity (#764)', () => {
  // An origin:e2e issue authored by ANOTHER user is not eligible — the label alone is provenance
  // anyone with triage access can apply (#764 fixture 1, foreign author).
  const foreign = cand(issue({ number: 4, user: { login: 'mercury-bot[bot]' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-21T00:00:00Z' }));
  const sForeign = selectLadder([foreign], TERMINAL);
  assert.notEqual(sForeign.issue, 4);
  assert.equal(sForeign.rung === 'none' || sForeign.rung === 4, true);

  // The SAME issue authored by the nightly identity, with the e2e label applied by the nightly
  // identity, is eligible (fixture 1, nightly author).
  const nightly = cand(
    issue({ number: 5, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-21T00:00:00Z' }),
    [e2eLabeled('mercury-nightly')],
  );
  const sNightly = selectLadder([nightly], TERMINAL);
  assert.equal(sNightly.rung, 1);
  assert.equal(sNightly.issue, 5);
  assert.match(sNightly.reason, /origin:e2e/);

  // Nightly-authored WITHOUT origin:e2e is not eligible through this clause (fixture 2); it is
  // also not rung 3 (rung 3 requires @aywengo authorship) — it lands on rung 4/none.
  const noLabel = cand(issue({ number: 6, user: { login: 'mercury-nightly' }, created_at: '2026-09-21T00:00:00Z' }));
  const sNone = selectLadder([noLabel], TERMINAL);
  assert.notEqual(sNone.issue, 6);

  // An e2e label applied by someone OTHER than the nightly identity fails the actor check even
  // with the nightly author — the same standard as nightly:ready.
  const stolen = cand(
    issue({ number: 7, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-21T00:00:00Z' }),
    [e2eLabeled('random-dev')],
  );
  const sStolen = selectLadder([stolen], TERMINAL);
  assert.notEqual(sStolen.issue, 7);

  // The CURRENT actor decides: nightly applied it, someone unlabeled and re-applied it — not trusted.
  const takenOver = cand(
    issue({ number: 8, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-21T00:00:00Z' }),
    [
      e2eLabeled('mercury-nightly'),
      { event: 'unlabeled', actor: { login: 'random-dev' }, label: { name: 'origin:e2e' } },
      e2eLabeled('random-dev'),
    ],
  );
  const sTaken = selectLadder([takenOver], TERMINAL);
  assert.notEqual(sTaken.issue, 8);
});

test('nightly:ready by @aywengo trusts a nightly-authored issue (ready clause is author-independent)', () => {
  // The ready clause does not care who authored the issue: a @aywengo-applied CURRENT ready label
  // makes even a mercury-nightly-authored issue eligible (#764 review round 2).
  const c = cand(
    issue({ number: 60, user: { login: 'mercury-nightly' }, labels: [{ name: 'nightly:ready' }], created_at: '2026-09-21T00:00:00Z' }),
    [labeled('aywengo', 'nightly:ready')],
  );
  const s = selectLadder([c], TERMINAL);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 60);
});

test('mutation control: the label-only check would trust the foreign e2e issue (#764 fixture 3)', () => {
  // The pre-#764 behavior — trusting any issue that carries origin:e2e — would pick issue 4 here.
  // If this fixture ever picks 4, the label-only check is back.
  const foreign = cand(issue({ number: 4, user: { login: 'random-dev' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-20T00:00:00Z' }));
  const s = selectLadder([foreign], TERMINAL);
  assert.notEqual(s.issue, 4, 'origin:e2e without nightly identity authorship must stay ineligible');
  // Direct on the unit (round-7 note): the ladder-level fixture above cannot see a PARTIAL
  // regression where isTrusted trusts a bare label again while rung-1 still requires
  // e2eByNightly. Assert the trust predicate itself: a bare label with a foreign author and a
  // nightly author without the actor verification are both untrusted, in every combination.
  const bare = issue({ number: 4, user: { login: 'random-dev' }, labels: [{ name: 'origin:e2e' }] });
  assert.equal(isTrusted(bare, false, false), false);
  assert.equal(isTrusted(bare, true, false), true, 'the ready clause stays author-independent');
  const nightlyBare = issue({ number: 5, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }] });
  assert.equal(isTrusted(nightlyBare, false, false), false,
    'label present + nightly author but the actor check failed: NOT trusted');
  assert.equal(isTrusted(nightlyBare, false, true), true,
    'label present + nightly author + actor verified: trusted');
});

test('rung 1 orders by priority label then age', () => {
  const old_low = cand(issue({ number: 10, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }, { name: 'priority: low' }], created_at: '2026-09-10T00:00:00Z' }), [e2eLabeled('mercury-nightly')]);
  const new_high = cand(issue({ number: 11, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }, { name: 'priority: high' }], created_at: '2026-09-24T00:00:00Z' }), [e2eLabeled('mercury-nightly')]);
  const old_none = cand(issue({ number: 12, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }], created_at: '2026-09-11T00:00:00Z' }), [e2eLabeled('mercury-nightly')]);
  const s = selectLadder([old_low, new_high, old_none], TERMINAL);
  assert.equal(s.issue, 11, 'high priority beats older low/no-priority');
  const s2 = selectLadder([old_low, old_none], TERMINAL);
  assert.equal(s2.issue, 10, 'low has a priority rank; absent priority sorts last');
  const same_pri_old = cand(issue({ number: 13, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }, { name: 'priority: high' }], created_at: '2026-09-12T00:00:00Z' }), [e2eLabeled('mercury-nightly')]);
  const s3 = selectLadder([new_high, same_pri_old], TERMINAL);
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
  assert.equal(s.rung, 3);
  assert.equal(s.issue, 30, 'rung 1 empty, oldest first');
  // A labeled @aywengo issue is NOT rung 3 (labels mean someone triaged it).
  const labeled_ay = issue({ number: 32, user: { login: 'aywengo' }, labels: [{ name: 'bug' }] });
  const s2 = selectLadder([cand(labeled_ay)], TERMINAL);
  assert.notEqual(s2.issue, 32);
});

test('rung 1 waits until tonight\'s nightly-e2e Run is terminal', () => {
  const c = cand(issue({ number: 40, labels: [{ name: 'origin:e2e' }] }));
  const s = selectLadder([c], { e2eRunTerminal: false });
  assert.notEqual(s.issue, 40, 'e2e verdict still open: rung 1 does not offer work');
  // Rung 3 still works while e2e is open.
  const ay = issue({ number: 41, user: { login: 'aywengo' } });
  const s2 = selectLadder([c, cand(ay)], { e2eRunTerminal: false });
  assert.equal(s2.rung, 3);
  assert.equal(s2.issue, 41);
});

test('rung 4 / none', () => {
  const s = selectLadder([cand(issue({ number: 50, user: { login: 'random' }, labels: [{ name: 'question' }] }))], TERMINAL);
  assert.equal(s.rung, 4, 'untrusted issues exist but nothing eligible: docs → proposals rung');
  const s2 = selectLadder([], TERMINAL);
  assert.equal(s2.rung, 'none');
});

test('isTrusted / isExcluded / priorityRank unit behavior', () => {
  assert.equal(isTrusted(issue({ number: 1, user: { login: 'aywengo' } }), false, false), true);
  assert.equal(isTrusted(issue({ number: 2, user: { login: 'x' }, labels: [{ name: 'origin:e2e' }] }), false, false), false,
    'a bare origin:e2e label with a foreign author is NOT trusted (#764)');
  assert.equal(isTrusted(issue({ number: 3, user: { login: 'x' } }), true, false), true, 'ready-by-trusted flag');
  assert.equal(isTrusted(issue({ number: 4, user: { login: 'x' } }), false, false), false);
  assert.equal(isExcluded(issue({ number: 5, labels: [{ name: 'nightly:in-progress' }] })), true);
  assert.equal(priorityRank(issue({ number: 6, labels: [{ name: 'priority: high' }] })), 0);
  assert.equal(priorityRank(issue({ number: 7, labels: [{ name: 'priority: low' }] })), 2);
  assert.equal(priorityRank(issue({ number: 8 })), 3);
});

test('readyActorsFor tracks the CURRENT ready state, not history (round-2 review)', () => {
  // aywengo labeled, then UNLABELED: no current ready approval.
  const unlabeled: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', actor: { login: 'x' }, label: { name: 'bug' } },
    { event: 'unlabeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 9 }), unlabeled), []);
  // aywengo labeled, someone else unlabeled and re-labeled: the CURRENT approval is not aywengo's.
  const taken_over: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'unlabeled', actor: { login: 'random-dev' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', actor: { login: 'random-dev' }, label: { name: 'nightly:ready' } },
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 10 }), taken_over), ['random-dev']);
  assert.equal(isTrusted(issue({ number: 10, labels: [{ name: 'nightly:ready' }] }), readyActorsFor(issue({ number: 10 }), taken_over).includes('aywengo'), false), false);
  // aywengo labeled, other unlabeled, aywengo re-labeled: trusted again.
  const reclaimed: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'unlabeled', actor: { login: 'random-dev' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 11 }), reclaimed), ['aywengo']);
  // The simple case stays: one labeled event by aywengo.
  const simple: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', actor: { login: 'x' }, label: { name: 'bug' } },
    { event: 'closed', actor: { login: 'aywengo' } },
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 12 }), simple), ['aywengo']);
});


test('runSelectorWith claims exactly one issue and returns it (normal case)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const events: string[] = [];
  // #801 round 3: after the claim POST the selector verifies ownership through the timeline -
  // the final nightly:in-progress labeled event must carry the nightly identity (our own POST
  // makes us the last writer on GitHub).
  const ourClaim = [{ event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' } }];
  const io = {
    async get(path: string) {
      events.push(`get ${path}`);
      if (path.includes('/timeline')) return { body: ourClaim, link: null };
      return { body: [issue({ number: 60, user: { login: 'aywengo' } })], link: null };
    },
    async post(path: string) {
      events.push(`post ${path}`);
      return true;
    },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.rung, 3);
  assert.equal(s.issue, 60, 'the claimed issue is returned');
  assert.deepEqual(events.filter((e) => e.startsWith('post')), [
    'post /repos/aywengo/mercury/issues/60/labels',
  ], 'exactly one claim POST in the normal case');
  assert.ok(events.some((e) => e.includes('/timeline')), 'ownership is verified through the timeline after the claim');
  assert.ok(events.indexOf('post /repos/aywengo/mercury/issues/60/labels') !== -1, 'the claim is issued before runSelectorWith resolves');
  assert.match(s.reason, /#60/);
});

test('a foreign actor as the final claim event is NOT our claim: re-select (#801 round 3)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // GitHub's add-labels is idempotent (duplicate POST -> 200, verified 2026-09-30), so a
  // competitor's label looks identical to ours in the POST response; only the timeline actor
  // tells them apart.
  const theirClaim = [{ event: 'labeled', actor: { login: 'someone-else' }, label: { name: 'nightly:in-progress' } }];
  const posts: string[] = [];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: theirClaim, link: null };
      return { body: [issue({ number: 66, user: { login: 'aywengo' } })], link: null };
    },
    async post(path: string) { posts.push(path); return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.notEqual(s.issue, 66, 'the competitor holds the claim: the candidate is dropped');
  assert.equal(posts.length, 1, 'no second claim POST for a dropped candidate');
});

test('a capped claim-ownership walk fails closed: the candidate is dropped (#801 round 3)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  let timelineGets = 0;
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        timelineGets++;
        // Always another page: the walk hits its 10-page cap.
        return { body: [{ event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' } }], link: '<https://api.github.com/repos/aywengo/mercury/issues/67/timeline?per_page=100&page=2>; rel="next"' };
      }
      return { body: [issue({ number: 67, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.notEqual(s.issue, 67, 'ownership that cannot be verified is not ownership (fail closed)');
  assert.equal(timelineGets, 10, 'the walk bounded at its cap');
});

test('labelActorsFor: an actor-less labeled event fails closed (round-5 note)', () => {
  // A labeled event with no visible actor must NOT inherit the previous trusted actor: the final
  // state is UNKNOWN, which is not trusted.
  const withGap: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } },
    { event: 'labeled', label: { name: 'nightly:ready' } }, // actor missing (payload truncated?)
  ];
  assert.deepEqual(readyActorsFor(issue({ number: 80 }), withGap), [],
    'an actor-less final labeled event is unknown, not the previous actor');
  // Same for the e2e label path.
  const e2eGap: LabelEvent[] = [
    { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'origin:e2e' } },
    { event: 'labeled', label: { name: 'origin:e2e' } },
  ];
  assert.deepEqual(labelActorsFor(e2eGap, 'origin:e2e'), []);
  // An actor-less label followed by a visible re-label resolves to the visible actor.
  const recovered: LabelEvent[] = [
    { event: 'labeled', label: { name: 'origin:e2e' } },
    { event: 'unlabeled', label: { name: 'origin:e2e' } },
    { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'origin:e2e' } },
  ];
  assert.deepEqual(labelActorsFor(recovered, 'origin:e2e'), ['mercury-nightly']);
});

test('runSelectorWith: a foreign-author issue with BOTH labels reports the ready reason (round-6)', async () => {
  // A foreign-author issue carrying nightly:ready AND origin:e2e gets its timeline walked for the
  // ready clause; e2eByNightly must still be false (the author check lives in the assignment), so
  // a rung-1 pick reports the ready reason, never the e2e reason.
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }, { event: 'labeled', actor: { login: 'random-dev' }, label: { name: 'origin:e2e' } }], link: null };
      }
      return { body: [issue({ number: 90, user: { login: 'random-dev' }, labels: [{ name: 'nightly:ready' }, { name: 'origin:e2e' }] })], link: null };
    },
    async post(path: string) { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 90);
  assert.match(s.reason, /nightly:ready/, 'the reason names the ready clause, not the e2e clause');
  assert.doesNotMatch(s.reason, /origin:e2e/);
});

test('runSelectorWith skips the e2e timeline walk for non-nightly authors (#764 round 3)', async () => {
  // The e2e trust clause can only pass for nightly-authored issues, so the timeline (the most
  // expensive per-issue read) is walked only for nightly-authored e2e issues and ready-labeled
  // issues. A foreign-author e2e issue gets NO timeline call.
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const gets: string[] = [];
  const io = {
    async get(path: string) {
      gets.push(path);
      return { body: [
        issue({ number: 70, user: { login: 'random-dev' }, labels: [{ name: 'origin:e2e' }] }),
        issue({ number: 71, user: { login: 'aywengo' } }),
      ], link: null };
    },
    async post(path: string) { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 3, 'the foreign e2e issue is not eligible; the @aywengo issue is rung 3');
  assert.equal(gets.filter((p) => p.includes('/timeline')).length, 0,
    'no timeline is walked for a foreign-author origin:e2e issue');
  // And the nightly-authored e2e issue DOES get its timeline walked.
  const gets2: string[] = [];
  const io2 = {
    async get(path: string) {
      gets2.push(path);
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'origin:e2e' } }], link: null };
      }
      return { body: [issue({ number: 72, user: { login: 'mercury-nightly' }, labels: [{ name: 'origin:e2e' }] })], link: null };
    },
    async post(path: string) { return true; },
  };
  const s2 = await runSelectorWith(io2, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s2.rung, 1, 'the nightly-authored e2e issue passes through the timeline actor check');
  assert.equal(gets2.filter((p) => p.includes('/timeline')).length, 1,
    'exactly one timeline walk for the nightly-authored e2e issue');
});

test('runSelectorWith re-selects only when GitHub says the claim is not ours (racer)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const posts: string[] = [];
  let first = true;
  const ourClaim = [{ event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' } }];
  const theirClaim = [{ event: 'labeled', actor: { login: 'racer-bot' }, label: { name: 'nightly:in-progress' } }];
  const io = {
    async get(path: string) {
      if (path.includes('/issues/62/timeline')) return { body: theirClaim, link: null };
      if (path.includes('/timeline')) return { body: ourClaim, link: null };
      return { body: [issue({ number: 62, user: { login: 'aywengo' } }), issue({ number: 63, user: { login: 'aywengo' } })], link: null };
    },
    async post(path: string) {
      posts.push(path);
      if (first) { first = false; return true; } // 200 (idempotent), but #62's timeline says racer
      return true;
    },
  };
  // Round 3 (#801): the racer signal is the TIMELINE ACTOR, not a 422 - GitHub's add-labels is
  // idempotent. The first candidate's claim is not ours, so it is dropped and #63 is claimed.
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.deepEqual(posts, [
    '/repos/aywengo/mercury/issues/62/labels',
    '/repos/aywengo/mercury/issues/63/labels',
  ], 'the racer-taken candidate is dropped, the next one is claimed');
  assert.equal(s.issue, 63);
  assert.equal(s.rung, 3);
});

test('runSelectorWith --dry-run never posts the claim', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const posts: string[] = [];
  const io = {
    async get() { return { body: [issue({ number: 70, user: { login: 'aywengo' } })], link: null }; },
    async post(path: string) { posts.push(path); return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.issue, 70);
  assert.deepEqual(posts, [], '--dry-run prints the decision and writes nothing');
});


test('e2eRunTerminal fails CLOSED when the gate is configured but unevaluable (round-1 review)', async () => {
  const { e2eRunTerminal } = await import('../.agents/skills/nightly/select.ts');
  // Unset env: no gate configured → passed.
  assert.equal(await e2eRunTerminal({}), true);
  // HALF-configured (exactly one of URL/token): a misconfiguration fails closed.
  assert.equal(await e2eRunTerminal({ MERCURY_API_URL: 'http://127.0.0.1:9' }), false);
  assert.equal(await e2eRunTerminal({ MERCURY_API_TOKEN: 't' }), false);
  // Configured but unreachable → fail closed.
  assert.equal(await e2eRunTerminal({ MERCURY_API_URL: 'http://127.0.0.1:9', MERCURY_API_TOKEN: 't' }), false, 'unreachable host: rung 1 must not start on a guess');
  // Configured, reachable, non-2xx → fail closed.
  const S = await (async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_req, res) => { res.statusCode = 500; res.end('boom'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    return { srv, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
  })();
  try {
    assert.equal(await e2eRunTerminal({ MERCURY_API_URL: S.url, MERCURY_API_TOKEN: 't' }), false, 'non-2xx: fail closed');
  } finally {
    S.srv.close();
  }
});


test('e2eRunTerminal fails closed when the page cap is hit with more pages beyond (round-6 review)', async () => {
  const { e2eRunTerminal } = await import('../.agents/skills/nightly/select.ts');
  const { createServer } = await import('node:http');
  // Always another page, never an e2e Run in sight: the cap must fail the gate, not pass it.
  let n = 0;
  const srv = createServer((_req, res) => {
    n++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runs: [{ task: 'nightly-report', status: 'COMPLETED' }], nextCursor: `c${n}` }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    assert.equal(await e2eRunTerminal({ MERCURY_API_URL: url, MERCURY_API_TOKEN: 't' }), false, 'more pages beyond the cap: fail closed');
    assert.ok(n >= 20, 'the walk actually hit the cap');
  } finally {
    srv.close();
  }
});

test('runSelectorWith refuses an empty or malformed REPO before building URLs (round-3 review)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = { async get() { return []; }, async post() { return true; } };
  await assert.rejects(() => runSelectorWith(io, { REPO: '' }, true), /REPO must be exactly owner\/name/);
  await assert.rejects(() => runSelectorWith(io, {}, true), /REPO must be exactly owner\/name/);
  await assert.rejects(() => runSelectorWith(io, { REPO: 'owner/name/extra' }, true), /REPO must be exactly owner\/name/);
  await assert.rejects(() => runSelectorWith(io, { REPO: 'owner/name?x=y' }, true), /REPO must be exactly owner\/name/);
});

test('e2eRunTerminal walks pages: a non-terminal e2e Run past page one fails the gate (round-3 review)', async () => {
  const { e2eRunTerminal } = await import('../.agents/skills/nightly/select.ts');
  // Local fake host serving two pages: page 1 has other tasks, page 2 has a RUNNING nightly-e2e.
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.searchParams.get('cursor')) {
      res.end(JSON.stringify({ runs: [{ task: 'nightly-e2e', status: 'RUNNING' }], nextCursor: null }));
    } else {
      res.end(JSON.stringify({ runs: [{ task: 'nightly-report', status: 'COMPLETED' }], nextCursor: 'c2' }));
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    assert.equal(await e2eRunTerminal({ MERCURY_API_URL: url, MERCURY_API_TOKEN: 't' }), false, 'the aging-out RUNNING e2e Run must still gate rung 1');
  } finally {
    srv.close();
  }
});


test('the open-issue list walks Link-header pages (round-4 review)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const paths: string[] = [];
  const ourClaim = [{ event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' } }];
  const io = {
    async get(path: string) {
      paths.push(path);
      if (path.includes('/timeline')) return { body: ourClaim, link: null };
      if (path.includes('page=2') || path.includes('page%3D2')) {
        return { body: [issue({ number: 82, user: { login: 'aywengo' } })], link: null };
      }
      return {
        body: [issue({ number: 81, user: { login: 'random' }, labels: [{ name: 'question' }] })],
        link: '<https://api.github.com/repos/aywengo/mercury/issues?state=open&per_page=100&page=2>; rel="next"',
      };
    },
    async post() { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.issue, 82, 'the page-2 candidate is visible to the ladder');
  assert.equal(paths.filter((p) => p.startsWith('/repos/aywengo/mercury/issues?')).length, 2, 'both issue-list pages fetched');
  assert.equal(paths.filter((p) => p.startsWith('/repos/aywengo/mercury/pulls?')).length >= 1, true, 'the resume scan reads the open-PR list');
});


test('the timeline walk is paginated and a hit cap fails closed (round-5 review)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const ready_issue = issue({ number: 90, labels: [{ name: 'nightly:ready' }] });
  const paths: string[] = [];
  const io = {
    async get(path: string) {
      paths.push(path);
      if (path.includes('/timeline')) {
        paths.push(`tl:${path}`);
        if (path.includes('page=2')) {
          return { body: [{ event: 'labeled', actor: { login: 'random-dev' }, label: { name: 'nightly:ready' } }], link: null };
        }
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: '<https://api.github.com/repos/aywengo/mercury/issues/90/timeline?per_page=100&page=2>; rel="next"' };
      }
      return { body: [ready_issue], link: null };
    },
    async post() { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.issue, undefined, 'the CURRENT ready actor (page 2) is random-dev, not aywengo: not trusted');
  assert.ok(paths.some((p) => p.includes('page=2')), 'the second timeline page was fetched');
  // A capped walk (always another page) fails closed: no claim, rung 4/none, not trusted.
  const io2 = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: '<https://api.github.com/repos/aywengo/mercury/issues/90/timeline?per_page=100&page=2>; rel="next"' };
      }
      return { body: [ready_issue], link: null };
    },
    async post() { return true; },
  };
  const posts: string[] = [];
  const io3 = { async get(path: string) { return io2.get(path); }, async post(p2: string) { posts.push(p2); return true; } };
  const s2 = await runSelectorWith(io3, { REPO: 'aywengo/mercury' }, false);
  assert.deepEqual(posts, [], 'a capped timeline never trusts: no claim is attempted');
  assert.notEqual(s2.rung, 1);
});


test('ghPost 422: only already-exists re-selects; other validation failures throw (round-9 review)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // A 422 whose body does NOT indicate already-exists must surface, not silently skip work.
  const io = {
    async get() { return { body: [issue({ number: 95, user: { login: 'aywengo' } })], link: null }; },
    async post() {
      const err = new Error('POST /labels -> 422 validation failed: Invalid request.\n\n"labels" for code "invalid"');
      throw err;
    },
  };
  // The injected post throws (the real ghPost would for a non-already-exists 422): runSelectorWith
  // propagates it instead of re-selecting.
  await assert.rejects(() => runSelectorWith(io, { REPO: 'aywengo/mercury' }, false), /422 validation failed/);
});

test('a capped open-issue list reports rung 4, never a false none (round-9 review)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const paths: string[] = [];
  const io = {
    async get(path: string) {
      paths.push(path);
      // Every page has ONLY PRs (filtered out) and always another page: 0 candidates, capped.
      // Pages 1..10 all return a next link, so the walk hits the 10-page cap mid-list.
      return { body: [issue({ number: 100 + paths.length, pull_request: {} })], link: `<https://api.github.com/repos/aywengo/mercury/issues?state=open&per_page=100&page=${paths.length + 1}>; rel="next"` };
    },
    async post() { return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.rung, 4, 'a capped walk means open items exist beyond the cap: docs rung, not none');
  const issuePages = paths.filter((p) => p.includes('/issues?')).length;
  assert.equal(issuePages, 10, 'the ISSUE-list walk stopped at the cap');
});


// ---- #800: the enhancement rung and the stale-claim reset ----

// #1001 decision A (@aywengo, 2026-10-19): rung 2 additionally requires `nightly:ready`.
// Rung 1 already takes every trusted ready issue, so rung 2 is only reachable while rung 1 is
// gated off - the tests below close the gate where they mean to exercise rung 2 itself.
const GATED_OFF = { e2eRunTerminal: false };
const readyTl = [labeled('aywengo', 'nightly:ready')];

test('rung 2: an enhancement WITHOUT nightly:ready is never claimed (#1001 decision A, the #972 case)', () => {
  // #972 was claimed at 00:21 while its body still said "Not nightly:ready yet". An
  // `enhancement` label alone is no longer a work signal.
  const enh = issue({ number: 11, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }] });
  for (const opts of [TERMINAL, GATED_OFF]) {
    const s = selectLadder([cand(enh)], opts);
    assert.notEqual(s.rung, 2, 'never rung 2 without a ready label');
    assert.notEqual(s.issue, 11, 'the issue is not claimed');
  }
});

test('rung 2: a ready enhancement is claimed, priority then age (#800 + #1001 decision A)', () => {
  const older = issue({ number: 11, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }, { name: 'nightly:ready' }], created_at: '2026-09-21T00:00:00Z' });
  const newerHigh = issue({ number: 12, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }, { name: 'nightly:ready' }, { name: 'priority: high' }], created_at: '2026-09-23T00:00:00Z' });
  // With tonight's verdict in, rung 1 takes it: a ready issue is rung-1 work regardless of labels.
  const s1 = selectLadder([cand(older, readyTl), cand(newerHigh, readyTl)], TERMINAL);
  assert.equal(s1.rung, 1);
  assert.equal(s1.issue, 12, 'priority: high beats age');
  // With the gate still open, rung 2 is what is left - and it orders the same way.
  const s = selectLadder([cand(older, readyTl), cand(newerHigh, readyTl)], GATED_OFF);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 12);
  assert.match(s.reason, /enhancement issue #12/);
  assert.match(s.reason, /nightly:ready by @aywengo/);
  const s2 = selectLadder([cand(older, readyTl)], GATED_OFF);
  assert.equal(s2.issue, 11, 'then oldest first');
  assert.match(s2.reason, /filed by @aywengo/);
});

test('rung 2: an enhancement label from an unverified actor on a foreign issue is NOT eligible (#800)', () => {
  // Same discipline as nightly:ready (#764): a label anyone can apply is not provenance. A
  // foreign-authored issue with a foreign-applied enhancement AND ready label stays out.
  const foreign = issue({ number: 13, user: { login: 'random-dev' }, labels: [{ name: 'enhancement' }, { name: 'nightly:ready' }] });
  const s = selectLadder([cand(foreign, [labeled('random-dev', 'enhancement'), labeled('random-dev', 'nightly:ready')])], GATED_OFF);
  assert.equal(s.rung === 'none' || s.rung === 4, true, 'falls through to the docs rung, never rung 2');
});

test('rung 2: an @aywengo-applied enhancement label trusts a foreign-author issue (#800)', () => {
  const nightlyAuthored = issue({ number: 14, user: { login: 'mercury-nightly' }, labels: [{ name: 'enhancement' }, { name: 'nightly:ready' }] });
  const s = selectLadder([cand(nightlyAuthored, [labeled('aywengo', 'enhancement'), ...readyTl])], GATED_OFF);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 14);
  assert.match(s.reason, /labeled enhancement by @aywengo/);
});

test('rung 2: a ready label applied by someone other than @aywengo does not qualify an enhancement (#1001 decision A)', () => {
  // The ready requirement is the same trust root as rung 1's: the ACTOR of the current label.
  const enh = issue({ number: 15, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }, { name: 'nightly:ready' }] });
  const s = selectLadder([cand(enh, [labeled('random-dev', 'nightly:ready')])], GATED_OFF);
  assert.notEqual(s.rung, 2);
  assert.notEqual(s.issue, 15, 'an untrusted ready label is not a ready signal');
});

test('a stale nightly:in-progress claim is reset and the issue becomes selectable (#800)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // Claim labeled three days ago: a deadline-stopped Run's leftover (§4.3 "the next night
  // resets it" - previously promised, never implemented).
  const claimed = issue({ number: 61, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const staleEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: '2026-09-27T21:00:00Z' };
  const dels: string[] = [];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [staleEvent], link: null };
      return { body: [claimed], link: null };
    },
    async post(path: string) { return true; },
    async del(path: string) { dels.push(path); return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.issue, 61, 'the stale-claimed issue is selected');
  assert.deepEqual(dels, ['/repos/aywengo/mercury/issues/61/labels/nightly%3Ain-progress' ], 'the stale claim is removed before the new claim');
});

test('a claim from TONIGHT still excludes the issue (live Run, not stale) (#800)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const claimed = issue({ number: 62, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const freshEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [freshEvent], link: null };
      return { body: [claimed], link: null };
    },
    async post(path: string) { return true; },
    async del(path: string) { dels.push(path); return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.notEqual(s.issue, 62, 'a tonight-claim means a live concurrent Run');
  assert.equal(dels.length, 0, 'nothing is deleted behind a live claim');
});

test('--dry-run resets nothing: the stale claim is only reported around (#800)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const claimed = issue({ number: 63, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const staleEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: '2026-09-27T21:00:00Z' };
  const dels: string[] = [];
  const posts: string[] = [];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [staleEvent], link: null };
      return { body: [claimed], link: null };
    },
    async post(path: string) { posts.push(path); return true; },
    async del(path: string) { dels.push(path); return true; },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.issue, 63, 'dry-run reports the decision');
  assert.equal(dels.length, 0, 'dry-run writes nothing');
  assert.deepEqual(posts, []);
});

test('a FAILED stale-claim reset fails closed for that issue only (#800)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const claimed = issue({ number: 64, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const fresh = issue({ number: 65, user: { login: 'aywengo' } });
  const staleEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: '2026-09-27T21:00:00Z' };
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [staleEvent], link: null };
      return { body: [claimed, fresh], link: null };
    },
    async post(path: string) { return true; },
    async del() { throw new Error('GitHub 500'); },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.issue, 65, 'the stuck issue is skipped, the rest of the night still works');
});

test('lastLabeledAt walks the timeline like labelActorsFor (re-label loses the old date) (#800)', async () => {
  const { lastLabeledAt } = await import('../.agents/skills/nightly/select.ts');
  const timeline = [
    { event: 'labeled', label: { name: 'nightly:in-progress' }, created_at: '2026-09-20T00:00:00Z' },
    { event: 'unlabeled', label: { name: 'nightly:in-progress' } },
    { event: 'labeled', label: { name: 'nightly:in-progress' }, created_at: '2026-09-29T12:00:00Z' },
  ];
  assert.equal(lastLabeledAt(timeline, 'nightly:in-progress'), '2026-09-29T12:00:00Z');
  assert.equal(lastLabeledAt([timeline[0]!], 'nightly:in-progress'), '2026-09-20T00:00:00Z');
  assert.equal(lastLabeledAt([{ event: 'unlabeled', label: { name: 'nightly:in-progress' } }], 'nightly:in-progress'), null);
  assert.equal(lastLabeledAt([], 'nightly:in-progress'), null);
});

// -- Resume rung (rung 0, #819): finish an earlier night's PR before claiming anything new.

function resume(over: Partial<ResumeCandidate> & { issue: number; prNumber: number }): ResumeCandidate {
  return {
    headSha: `sha${over.prNumber}`,
    state: 'findings',
    createdAt: '2026-10-02T22:00:00Z',
    ...over,
  } as ResumeCandidate;
}

test('rung 0: an open nightly PR with Copilot findings on its head resumes before rung 1 (#819)', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }], created_at: '2026-09-01T00:00:00Z' }))];
  const s = selectLadder(c, { ...TERMINAL, resume: [resume({ issue: 3, prNumber: 811 })] });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 3);
  assert.match(s.reason, /PR #811/);
  assert.match(s.reason, /findings/);
});

test('rung 0 is oldest-PR-first across issues and states the supersession count', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }] })), cand(issue({ number: 5, labels: [{ name: 'nightly:ready' }] }))];
  const s = selectLadder(c, {
    ...TERMINAL,
    resume: [
      resume({ issue: 5, prNumber: 900, createdAt: '2026-10-02T23:00:00Z' }),
      resume({ issue: 3, prNumber: 811, createdAt: '2026-10-02T22:00:00Z' }),
    ],
  });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 3, 'the older PR wins');
  assert.match(s.reason, /1 more PR/);
});

test('rung 0 with two PRs for one issue continues the OLDER one (supersession rule)', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }] }))];
  const s = selectLadder(c, {
    ...TERMINAL,
    resume: [
      resume({ issue: 3, prNumber: 817, createdAt: '2026-10-02T22:37:00Z' }),
      resume({ issue: 3, prNumber: 811, createdAt: '2026-10-01T22:36:00Z' }),
    ],
  });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 3);
  assert.match(s.reason, /PR #811/, 'the OLDER PR (811) is continued, not 817');
});

test('rung 0 empty or absent falls through to the normal ladder', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')])];
  const s = selectLadder(c, TERMINAL);
  assert.equal(s.rung, 1);
  const s2 = selectLadder(c, { ...TERMINAL, resume: [] });
  assert.equal(s2.rung, 1);
});

test('rung 0 does not wait for the e2e gate (review remarks are not new work)', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }] }))];
  const s = selectLadder(c, { e2eRunTerminal: false, resume: [resume({ issue: 3, prNumber: 811 })] });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 3);
});

test('rung 0 ignores resume candidates whose issue is absent from the open list', () => {
  const c = [cand(issue({ number: 3, user: { login: 'random-dev' }, labels: [{ name: 'nightly:in-progress' }] }))];
  const s = selectLadder(c, TERMINAL);
  assert.notEqual(s.rung, 0, 'no resume candidates passed, so no resume');
  const s2 = selectLadder(c, { ...TERMINAL, resume: [resume({ issue: 9, prNumber: 811 })] });
  assert.notEqual(s2.rung, 0, 'issue 9 is not in the open list: nothing to claim (#820 r1)');
});

// -- #820 review round 1 regressions --

// Blocker 1: a nightly:blocked issue's open PR must not re-enter rung 0.
test('rung 0 skips an issue excluded as nightly:blocked (the hand-off stands)', () => {
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }, { name: 'nightly:blocked' }] }), [labeled('aywengo', 'nightly:ready')])];
  const s = selectLadder(c, { ...TERMINAL, resume: [resume({ issue: 3, prNumber: 811 })] });
  assert.notEqual(s.rung, 0, 'a blocked issue is out of the resume rung');
});

// Blocker 3: COMMENTED with zero inline comments = approval-class, NOT pending findings.
test('a COMMENTED Copilot review with no inline comments on the head is not resume work', () => {
  // selectLadder-level: the rung only sees resume candidates the scanner already vetted, so
  // this test pins the CONTRACT (the reason text cannot claim findings without them) and the
  // runSelectorWith-level scanner test below pins the mechanism.
  const c = [cand(issue({ number: 3, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')])];
  const s = selectLadder(c, { ...TERMINAL, resume: [] });
  assert.notEqual(s.rung, 0);
});

// Blocker 4: two failed claims must not ping-pong.
test('runSelectorWith: two claim-verification failures exclude both issues from all rungs', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // Two trusted issues; timelines have NO labeled events (claim verify fails: 0 actors).
  // After the claim POST the timeline still shows no actor -> both fail -> rung 4 (no ping-pong).
  const issueList = [
    issue({ number: 301, user: { login: 'aywengo' } }),
    issue({ number: 302, user: { login: 'aywengo' } }),
  ];
  let posts = 0;
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: [], link: null };
      return { body: issueList, link: null };
    },
    async post() { posts++; return true; },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, false);
  assert.equal(posts, 2, 'one claim POST per issue, two issues tried');
  assert.equal(s.rung === 4 || s.rung === 'none', true, 'both claims failed: no infinite retry');
});

// Blocker 2 + blocker 3 mechanism: the scanner classifies PRs by head-review state.
test('runSelectorWith: resume only for UNRESOLVED threads; unreviewed/approved/resolved heads reserve the issue from rungs 1-3', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const trusted = issue({ number: 400, user: { login: 'aywengo' } });
  const prList = [
    // head reviewed with UNRESOLVED threads -> resume candidate
    { number: 811, user: { login: 'mercury-nightly' }, created_at: '2026-10-01T22:00:00Z', head: { sha: 'shaA', ref: 'fix/issue-400-x' } },
    // head NOT reviewed yet -> reserves the issue from rungs 1-3
    { number: 830, user: { login: 'mercury-nightly' }, created_at: '2026-10-02T22:00:00Z', head: { sha: 'shaB', ref: 'fix/issue-401-y' } },
    // head review approval-class (all threads resolved) -> awaiting merge, reserves too
    { number: 831, user: { login: 'mercury-nightly' }, created_at: '2026-10-02T23:00:00Z', head: { sha: 'shaC', ref: 'fix/issue-402-z' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: null };
      }
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/811/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaA', state: 'COMMENTED' }], link: null };
      }
      if (path.includes('/pulls/830/reviews')) return { body: [], link: null };
      if (path.includes('/pulls/831/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaC', state: 'COMMENTED' }], link: null };
      }
      return { body: [trusted, issue({ number: 401, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }] }), issue({ number: 402, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }] })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const vars = (body as { variables: { number: number } }).variables;
      // 811: one unresolved thread; 831: all resolved; 830 never queried (no review).
      const nodes = vars.number === 811
        ? [{ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'shaA' } }] } }]
        : [{ isResolved: true, isOutdated: true, comments: { nodes: [] } }];
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'the unresolved-thread PR resumes');
  assert.equal(s.issue, 400);
  assert.match(s.reason, /PR #811/);
});

// #847: a nightly PR whose branch does not name its issue (agent/run_*) is still mapped through
// its structured closing reference: resumed at rung 0 when the head has findings, and its issue
// stays reserved from rungs 1-3 either way.
test('runSelectorWith: a nightly PR with an unmapped branch maps via closingIssuesReferences and resumes (#847)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const trusted = issue({ number: 500, user: { login: 'aywengo' } });
  const prList = [
    // The #841 shape: nightly-authored, branch does NOT match fix/issue-N-*.
    { number: 900, user: { login: 'mercury-nightly' }, created_at: '2026-10-04T00:52:00Z', head: { sha: 'shaX', ref: 'agent/run_6e079f501ad344cd' } },
  ];
  let gqlQueries = 0;
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: null };
      }
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/900/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaX', state: 'COMMENTED' }], link: null };
      }
      return { body: [trusted], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const q = (body as { query: string }).query;
      if (q.includes('closingIssuesReferences')) {
        gqlQueries++;
        return { status: 200, body: { data: { repository: { p0: { closingIssuesReferences: { nodes: [{ number: 500, state: 'OPEN' }] } } } } } };
      }
      // reviewThreads for PR 900: one unresolved Copilot thread on the head.
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'shaX' } }] } }] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(gqlQueries, 1, 'exactly one batched closing-reference query');
  assert.equal(s.rung, 0, 'the unmapped-branch PR with findings resumes');
  assert.equal(s.issue, 500);
  assert.match(s.reason, /PR #900/);
});

test('runSelectorWith: an unmapped-branch nightly PR reserves its issue from rungs 1-3 (#847)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const trusted = issue({ number: 510, user: { login: 'aywengo' } });
  const prList = [
    { number: 901, user: { login: 'mercury-nightly' }, created_at: '2026-10-04T00:52:00Z', head: { sha: 'shaY', ref: 'agent/run_abc' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/901/reviews')) return { body: [], link: null };
      return { body: [trusted], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const q = (body as { query: string }).query;
      if (q.includes('closingIssuesReferences')) {
        return { status: 200, body: { data: { repository: { p0: { closingIssuesReferences: { nodes: [{ number: 510, state: 'OPEN' }] } } } } } };
      }
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.issue, 510, 'the mapped issue is reserved even though the PR awaits its first review');
  assert.equal(s.rung === 4 || s.rung === 'none', true);
});

test('runSelectorWith: a capped closingIssuesReferences connection aborts selection (#847 r1)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 903, user: { login: 'mercury-nightly' }, created_at: '2026-10-04T00:52:00Z', head: { sha: 'shaC1', ref: 'agent/run_ghi' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      return { body: [issue({ number: 530, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const q = (body as { query: string }).query;
      if (q.includes('closingIssuesReferences')) {
        return { status: 200, body: { data: { repository: { p0: { closingIssuesReferences: { pageInfo: { hasNextPage: true }, nodes: [] } } } } } };
      }
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 'none', 'a capped reference connection hides possible open issues: fail closed');
  assert.match(s.reason, /aborted/);
});

test('runSelectorWith: a failed closing-reference mapping aborts selection instead of duplicating work (#847)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 902, user: { login: 'mercury-nightly' }, created_at: '2026-10-04T00:52:00Z', head: { sha: 'shaZ', ref: 'agent/run_def' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      return { body: [issue({ number: 520, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
    async postJson() { return { status: 500, body: {} }; },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 'none', 'fail closed: no new work when the leftover PR cannot be mapped');
  assert.match(s.reason, /aborted/);
});

// r2 blocker 1: a failed/capped PR scan aborts selection - no claims at all.
test('runSelectorWith: a failed open-PR scan aborts selection instead of assuming absence', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = {
    async get(path: string) {
      if (path.includes('/pulls?')) throw new Error('503 Service Unavailable');
      return { body: [issue({ number: 5, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 'none');
  assert.match(s.reason, /aborted/);
});

// r2 blocker 2: an issue whose PR is APPROVED-class stays reserved from rungs 1-3.
test('runSelectorWith: an issue with an approved-class PR is not claimed as new work', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 831, user: { login: 'mercury-nightly' }, created_at: '2026-10-02T23:00:00Z', head: { sha: 'shaC', ref: 'fix/issue-402-z' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: null };
      }
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/831/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaC', state: 'COMMENTED' }], link: null };
      }
      return { body: [issue({ number: 402, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }] })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const vars = (body as { variables: { number: number } }).variables;
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.issue, 402, 'the approved-PR issue is reserved from rungs 1-3');
  assert.equal(s.rung === 4 || s.rung === 'none', true);
});

// r2 blocker 3: resolved threads are NOT pending findings even when inline comments exist.
test('runSelectorWith: fully resolved threads on the reviewed head never resume', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 811, user: { login: 'mercury-nightly' }, created_at: '2026-10-01T22:00:00Z', head: { sha: 'shaA', ref: 'fix/issue-400-x' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/811/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaA', state: 'COMMENTED' }], link: null };
      }
      return { body: [], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      // 3 threads, all resolved (waived findings): nothing pending.
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }, { isResolved: true }, { isResolved: true }] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'resolved threads are not work');
});

// -- #820 round-2 review regressions --

// r3 blocker 2: the production next.ts realIo() must supply postJson (otherwise rung 0 can
// never fire in production). Pinned by importing next.ts and checking the io it builds.
test('next.ts realIo supplies postJson (production resume wiring)', async () => {
  const mod = await import('../.agents/skills/nightly/next.ts');
  // realIo is not exported; pin the contract through the exports that exist: runNext must accept
  // an io WITHOUT postJson and still complete (fail-closed), and the source must wire it.
  const src = await (await import('node:fs/promises')).readFile('.agents/skills/nightly/next.ts', 'utf8');
  assert.match(src, /postJson: async \(path, body\) => await ghPost\(path, body, token\)/,
    'realIo must wire postJson, or production never resumes a PR');
});

// r3 blocker 3: oldest PR per issue is chosen BEFORE review state - a newer duplicate with
// findings must NOT preempt an older PR awaiting review.
test('runSelectorWith: the OLDEST duplicate PR is continued even when it awaits review and the newer has findings', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    // NEWER duplicate (817) with findings on its head
    { number: 817, user: { login: 'mercury-nightly' }, created_at: '2026-10-02T22:37:00Z', head: { sha: 'shaN', ref: 'fix/issue-406-y' } },
    // OLDER PR (811) whose head has NO review yet (awaiting the relay)
    { number: 811, user: { login: 'mercury-nightly' }, created_at: '2026-10-01T22:36:00Z', head: { sha: 'shaO', ref: 'fix/issue-406-x' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/817/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaN', state: 'COMMENTED' }], link: null };
      }
      if (path.includes('/pulls/811/reviews')) return { body: [], link: null };
      return { body: [issue({ number: 406, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }] })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const vars = (body as { variables: { number: number } }).variables;
      const nodes = vars.number === 817
        ? [{ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'shaN' } }] } }]
        : [];
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  // The older PR 811 awaits its review: the issue must NOT be resumed via the newer 817, and
  // 817 must be recorded as superseded (log) - selection reports rung 1+ or none, never rung 0.
  assert.notEqual(s.rung, 0, 'the newer duplicate must not preempt the older PR');
});

// r3 blocker 4: stale/foreign threads do not count as pending findings.
test('runSelectorWith: a clean head review with stale or foreign unresolved threads does not resume', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 811, user: { login: 'mercury-nightly' }, created_at: '2026-10-01T22:00:00Z', head: { sha: 'shaA', ref: 'fix/issue-400-x' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/811/reviews')) {
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaA', state: 'COMMENTED' }], link: null };
      }
      return { body: [issue({ number: 400, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      // Thread 1: from an OLDER review round (outdated, old commit). Thread 2: a foreign
      // reviewer. Thread 3: copilot but on an older commit. None is a current-head finding.
      const nodes = [
        { isResolved: false, isOutdated: true, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'old-commit' } }] } },
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'random-human' }, originalCommit: { oid: 'shaA' } }] } },
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'old-commit-2' } }] } },
      ];
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'stale/foreign threads are not current-head findings');
});

// -- #820 round-5 regressions: exact reviewer identity, no prefix matches --

test('runSelectorWith: a lookalike account cannot fake the verdict or the findings (#820 r5)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const prList = [
    { number: 811, user: { login: 'mercury-nightly' }, created_at: '2026-10-01T22:00:00Z', head: { sha: 'shaA', ref: 'fix/issue-400-x' } },
  ];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/811/reviews')) {
        return { body: [
          // Genuine Copilot review: findings on this head (unresolved thread below).
          { user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: 'shaA', state: 'COMMENTED' },
          // Lookalike APPROVED review - must NOT replace the last review (else the PR is
          // treated as awaiting-merge and the genuine findings are skipped).
          { user: { login: 'copilot-pull-request-reviewer-x' }, commit_id: 'shaA', state: 'APPROVED' },
        ], link: null };
      }
      return { body: [issue({ number: 400, user: { login: 'aywengo' } })], link: null };
    },
    async post() { return true; },
    async postJson(_path: string, body: unknown) {
      const nodes = [
        // Genuine unresolved copilot thread on the head (GraphQL author form, no suffix).
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'shaA' } }] } },
        // The [bot]-suffixed form (REST shape) is the same reviewer: it counts too.
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer[bot]' }, originalCommit: { oid: 'shaA' } }] } },
        // A lookalike account's thread must not count as a Copilot finding.
        { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer-x' }, originalCommit: { oid: 'shaA' } }] } },
      ];
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'the genuine review with unresolved findings resumes');
  assert.equal(s.issue, 400);
});

// #968: the owner's changes-requested review is resume work, not only Copilot findings.
function ownerReviewIo(opts: {
  ownerReviews: { state: string; commit_id: string }[];
  copilotThreads?: number;
  extraReadyIssue?: boolean;
}) {
  const trusted = issue({ number: 959, user: { login: 'aywengo' } });
  const prList = [
    { number: 1959, user: { login: 'mercury-nightly' }, created_at: '2026-10-14T22:35:00Z', head: { sha: 'headA', ref: 'fix/issue-959-status-changed-at' } },
  ];
  const issues = [trusted];
  if (opts.extraReadyIssue) issues.push(issue({ number: 970, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }, { name: 'priority: high' }] }));
  return {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: null };
      }
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/1959/reviews')) {
        return { body: opts.ownerReviews.map((r) => ({ user: { login: 'aywengo' }, ...r })), link: null };
      }
      return { body: issues, link: null };
    },
    async post() { return true; },
    async postJson() {
      const n = opts.copilotThreads ?? 0;
      const nodes = Array.from({ length: n }, () => ({ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'headA' } }] } }));
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: n, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
}

test('#968: the owner\'s CHANGES_REQUESTED review on the current head resumes the PR (no Copilot review at all)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(ownerReviewIo({ ownerReviews: [{ state: 'CHANGES_REQUESTED', commit_id: 'headA' }] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 959);
  assert.match(s.reason, /PR #1959/);
  assert.match(s.reason, /@aywengo's changes-requested review/);
});

test('#968: a commit pushed after the owner review waits for re-review instead of resuming again', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(ownerReviewIo({ ownerReviews: [{ state: 'CHANGES_REQUESTED', commit_id: 'olderSha' }] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'the head moved past the review: not resume work');
});

test('#968: a later owner APPROVED supersedes the change request; a later COMMENTED does not', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const approved = await runSelectorWith(ownerReviewIo({ ownerReviews: [
    { state: 'CHANGES_REQUESTED', commit_id: 'headA' }, { state: 'APPROVED', commit_id: 'headA' },
  ] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(approved.rung, 0, 'approved: awaiting merge');
  const commented = await runSelectorWith(ownerReviewIo({ ownerReviews: [
    { state: 'CHANGES_REQUESTED', commit_id: 'headA' }, { state: 'COMMENTED', commit_id: 'headA' },
  ] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(commented.rung, 0, 'a comment does not lift a change request');
});

test('#968: an owner change request outranks a newer nightly:ready issue, even a high-priority one', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(ownerReviewIo({ ownerReviews: [{ state: 'CHANGES_REQUESTED', commit_id: 'headA' }], extraReadyIssue: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 959);
});

test('#968: a CHANGES_REQUESTED review from anyone but the owner does not resume', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = ownerReviewIo({ ownerReviews: [] });
  const get = io.get;
  io.get = async (path: string) => (path.includes('/pulls/1959/reviews')
    ? { body: [{ user: { login: 'someone-else' }, state: 'CHANGES_REQUESTED', commit_id: 'headA' }], link: null }
    : get(path));
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0);
});

test('#968: ladder ordering puts owner change requests before older Copilot findings', () => {
  const c = [
    cand(issue({ number: 10, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 11, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
  ];
  const s = selectLadder(c, { ...TERMINAL, resume: [
    { issue: 10, prNumber: 100, headSha: 'a', state: 'findings', createdAt: '2026-10-01T00:00:00Z' },
    { issue: 11, prNumber: 101, headSha: 'b', state: 'owner-changes', createdAt: '2026-10-05T00:00:00Z' },
  ] });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 11, 'the owner review wins over an older Copilot-findings PR');
});


// ---- #1001: a claim left by a Run that ended with no PR and no comment ----

/** A fake host API for the liveness check (and the e2e gate, which reads the same list):
 * `runs` is what /api/runs returns. Returns the base URL and a closer. */
async function hostApi(runs: { id?: string; task?: string; status?: string }[]) {
  const { createServer } = await import('node:http');
  const srv = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runs, nextCursor: null }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  return { url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, close: () => srv.close() };
}

/** The io a claim-release test needs: one claimed issue, no PRs, and a comment list. */
function releaseIo(opts: {
  issue: GhIssue;
  claimEvent: LabelEvent;
  comments?: { user?: { login?: string } }[];
  pulls?: unknown[];
  dels: string[];
  posts: string[];
}) {
  return {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [opts.claimEvent], link: null };
      if (path.includes('/comments')) return { body: opts.comments ?? [], link: null };
      if (path.includes('/pulls?')) return { body: opts.pulls ?? [], link: null };
      return { body: [opts.issue], link: null };
    },
    async post(path: string) { opts.posts.push(path); return true; },
    async del(path: string) { opts.dels.push(path); return true; },
  };
}

test('a claim whose Run ended with no PR and no comment is released and re-selectable (#1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'dead', task: 'nightly-next', status: 'FAILED' }]);
  const claimed = issue({ number: 71, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  try {
    const s = await runSelectorWith(
      releaseIo({ issue: claimed, claimEvent, dels, posts }),
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      false,
    );
    assert.equal(s.issue, 71, 'the dead claim no longer excludes the issue');
    assert.deepEqual(dels, ['/repos/aywengo/mercury/issues/71/labels/nightly%3Ain-progress'], 'the claim is removed');
    assert.ok(posts.some((p) => p.endsWith('/issues/71/comments')), 'the release is recorded as a comment (the report reads it back)');
  } finally {
    host.close();
  }
});

test('a claim from a Run that is still alive is never released (#1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'other', task: 'nightly-next', status: 'RUNNING' }]);
  const claimed = issue({ number: 72, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  try {
    const s = await runSelectorWith(
      releaseIo({ issue: claimed, claimEvent, dels, posts }),
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      false,
    );
    assert.notEqual(s.issue, 72, 'a live Run still owns its claim');
    assert.deepEqual(dels, [], 'nothing is deleted behind a live Run');
  } finally {
    host.close();
  }
});

test('the selector does not count its OWN Run as alive (#1001)', async () => {
  const { nightlyRunAlive } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'me', task: 'nightly-next', status: 'RUNNING' }]);
  try {
    assert.equal(
      await nightlyRunAlive({ MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' }),
      false,
      'the Run asking the question is not a competitor for its own claim',
    );
    assert.equal(
      await nightlyRunAlive({ MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't' }),
      true,
      'without a self id the same Run is alive',
    );
  } finally {
    host.close();
  }
});

test('a claim whose Run commented on the issue is not released (#1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'dead', task: 'nightly-next', status: 'FAILED' }]);
  const claimed = issue({ number: 73, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  try {
    const s = await runSelectorWith(
      releaseIo({ issue: claimed, claimEvent, comments: [{ user: { login: 'mercury-nightly' } }], dels, posts }),
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      false,
    );
    assert.notEqual(s.issue, 73, 'a Run that commented produced output: the claim stays');
    assert.deepEqual(dels, []);
  } finally {
    host.close();
  }
});

test('a claim whose Run opened a PR is not released (#1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'dead', task: 'nightly-next', status: 'FAILED' }]);
  const claimed = issue({ number: 74, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  try {
    const s = await runSelectorWith(
      releaseIo({
        issue: claimed,
        claimEvent,
        pulls: [{ number: 900, user: { login: 'mercury-nightly' }, head: { ref: 'fix/issue-74-dead-run', sha: 'abc' }, created_at: '2026-10-18T00:30:00Z' }],
        dels,
        posts,
      }),
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      false,
    );
    assert.notEqual(s.issue, 74, 'an open nightly PR means the Run produced output');
    assert.deepEqual(dels, []);
  } finally {
    host.close();
  }
});

test('an unreadable liveness check keeps the claim (fail closed, #1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const claimed = issue({ number: 75, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  // No host API configured: liveness is unknown, so the clock-only behaviour stands.
  const s = await runSelectorWith(releaseIo({ issue: claimed, claimEvent, dels, posts }), { REPO: 'aywengo/mercury' }, false);
  assert.notEqual(s.issue, 75);
  assert.deepEqual(dels, [], 'unknown liveness never releases');
});

test('--dry-run reports the release without writing it (#1001)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'dead', task: 'nightly-next', status: 'FAILED' }]);
  const claimed = issue({ number: 76, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  try {
    const s = await runSelectorWith(
      releaseIo({ issue: claimed, claimEvent, dels, posts }),
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      true,
    );
    assert.equal(s.issue, 76, 'the decision is reported');
    assert.deepEqual(dels, [], 'dry-run writes nothing');
    assert.deepEqual(posts, []);
  } finally {
    host.close();
  }
});


test('a failed release COMMENT still makes the issue selectable (label-first, #1009 r1)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const host = await hostApi([{ id: 'dead', task: 'nightly-next', status: 'FAILED' }]);
  const claimed = issue({ number: 77, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const claimEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: new Date().toISOString() };
  const dels: string[] = [];
  const posts: string[] = [];
  const io = {
    async get(path: string) {
      if (path.includes('/timeline')) return { body: [claimEvent], link: null };
      if (path.includes('/comments')) return { body: [], link: null };
      if (path.includes('/pulls?')) return { body: [], link: null };
      return { body: [claimed], link: null };
    },
    async post(path: string) {
      posts.push(path);
      // The release record fails; the claim label add afterwards must still work.
      if (path.endsWith('/comments')) throw new Error('HTTP 503');
      return true;
    },
    async del(path: string) { dels.push(path); return true; },
  };
  try {
    const s = await runSelectorWith(
      io,
      { REPO: 'aywengo/mercury', MERCURY_API_URL: host.url, MERCURY_API_TOKEN: 't', MERCURY_RUN_ID: 'me' },
      false,
    );
    assert.deepEqual(dels, ['/repos/aywengo/mercury/issues/77/labels/nightly%3Ain-progress'], 'the claim was released on GitHub');
    assert.ok(posts.some((p) => p.endsWith('/comments')), 'the record was attempted');
    assert.equal(s.issue, 77, 'a failed record must not keep a released issue excluded for the night');
  } finally {
    host.close();
  }
});

// -- Red CI on the head (rung 0, #980): a nightly PR the bot pushed red resumes on the CI
// signal alone, without waiting for a human review to restate what CI already says.

// Fixture shaped like #965: a nightly PR whose head has a completed failing `ci` aggregate
// check, failing job check runs, no reviews and no Copilot threads.
function redCiIo(opts: {
  ciStatus?: string;
  ciConclusion?: string | null;
  /** A failing sibling job of the `ci` aggregate. `externalId` is the check run's
   *  `external_id` (integration-supplied: numeric for Actions, opaque otherwise, #980 r8);
   *  `detailsUrl` is the check run's `details_url`; `jobId` is the NUMERIC job id the log
   *  endpoint serves for (default: `externalId` when numeric — the pre-r8 world). `log` is the
   *  job log the known-flake guard reads (a job whose id resolves to nothing has no readable
   *  log — a real failure). `logStatus` overrides the fetch status; `logError` makes the
   *  transport throw. */
  failingJobs?: { name: string; conclusion?: string; externalId?: string; detailsUrl?: string; jobId?: string; log?: string; logStatus?: number; logError?: boolean }[];
  ownerReviews?: { state: string; commit_id: string }[];
  copilotThreads?: number;
  /** Capped thread query (hasNextPage: true): the review scan is INCOMPLETE, so review-based
   *  signals fail closed for the PR — CI-based signals are not review evidence (#980 r5). */
  threadsIncomplete?: boolean;
  extraReadyIssue?: boolean;
}) {
  const trusted = issue({ number: 965, user: { login: 'aywengo' } });
  const prList = [
    { number: 1965, user: { login: 'mercury-nightly' }, created_at: '2026-10-15T22:35:00Z', head: { sha: 'sha965', ref: 'fix/issue-965-typecheck' } },
  ];
  const issues = [trusted];
  if (opts.extraReadyIssue) issues.push(issue({ number: 975, user: { login: 'aywengo' }, labels: [{ name: 'nightly:ready' }, { name: 'priority: high' }] }));
  const checkRuns = [
    { name: 'ci', status: opts.ciStatus ?? 'completed', conclusion: opts.ciConclusion === undefined ? 'failure' : opts.ciConclusion },
    ...(opts.failingJobs ?? []).map((j) => ({ name: j.name, status: 'completed', conclusion: j.conclusion ?? 'failure', ...(j.externalId !== undefined ? { external_id: j.externalId } : {}), ...(j.detailsUrl !== undefined ? { details_url: j.detailsUrl } : {}) })),
    { name: 'changes', status: 'completed', conclusion: 'success' },
  ];
  return {
    async get(path: string) {
      if (path.includes('/timeline')) {
        return { body: [{ event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } }], link: null };
      }
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/1965/reviews')) {
        return { body: opts.ownerReviews ?? [], link: null };
      }
      if (path.includes('/check-runs?')) return { body: { check_runs: checkRuns }, link: null };
      return { body: issues, link: null };
    },
    async getText(path: string) {
      const m = path.match(/\/actions\/jobs\/(\d+)\/logs$/);
      if (!m) return null;
      const idOf = (j: { externalId?: string; jobId?: string }): string | undefined =>
        j.jobId ?? (j.externalId !== undefined && /^\d+$/.test(j.externalId) ? j.externalId : undefined);
      const job = (opts.failingJobs ?? []).find((j) => idOf(j) === m[1]);
      if (job?.logError) throw new Error('log fetch failed');
      if (!job || job.log === undefined) return { status: 404, text: 'Not Found' };
      return { status: job.logStatus ?? 200, text: job.log };
    },
    async post() { return true; },
    async postJson() {
      if (opts.threadsIncomplete) {
        return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: true }, nodes: [] } } } } } };
      }
      const n = opts.copilotThreads ?? 0;
      const nodes = Array.from({ length: n }, () => ({ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, originalCommit: { oid: 'sha965' } }] } }));
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: n, pageInfo: { hasNextPage: false }, nodes } } } } } };
    },
  };
}

test('#980: a nightly PR whose head has red ci resumes on the CI signal, reason names the failing jobs', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({
    failingJobs: [
      { name: 'test (node 22.18.0)' },
      { name: 'host-installer' },
      { name: 'plan-tracker' },
    ],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'red ci on the head is resume work without any review');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /red ci on head sha965/);
  assert.match(s.reason, /test \(node 22\.18\.0\)/);
  assert.match(s.reason, /plan-tracker/);
});

test('#980: a head whose failing job concluded timed_out is selected at rung 0', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', conclusion: 'timed_out' }],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'a timed-out job leaves a red head the bot must come back to');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /test \(node 22\.18\.0\)/);
});

test('#980: a head whose failing job concluded cancelled is selected at rung 0', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'uninstall', conclusion: 'cancelled' }],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'a cancelled job leaves a red head the bot must come back to');
  assert.match(s.reason, /uninstall/);
});

test('#980: a failed aggregate with no nameable sibling job still resumes (unknown job)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({ failingJobs: [] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'the failed aggregate itself is the signal');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /red ci on head sha965: unknown job/);
});

test('#980: a `ci` check still in progress is not a signal', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({ ciStatus: 'in_progress', failingJobs: [] }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'wait for the verdict instead of resuming on a running check');
});

test('#980: an owner change request outranks red ci on another PR', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // Two nightly PRs: PR 1 (older) has red ci, PR 2 (newer) has an owner change request.
  const trusted = issue({ number: 965, user: { login: 'aywengo' } });
  const trusted2 = issue({ number: 966, user: { login: 'aywengo' } });
  const prList = [
    { number: 1965, user: { login: 'mercury-nightly' }, created_at: '2026-10-15T22:35:00Z', head: { sha: 'sha965', ref: 'fix/issue-965-typecheck' } },
    { number: 1966, user: { login: 'mercury-nightly' }, created_at: '2026-10-16T20:00:00Z', head: { sha: 'sha966', ref: 'fix/issue-966-other' } },
  ];
  const base = redCiIo({ failingJobs: [{ name: 'test (node 22.18.0)' }] }) as { get: (p: string) => Promise<unknown>; post: () => Promise<boolean>; postJson: (p: string, b: unknown) => Promise<{ status: number; body: unknown }> };
  const io = {
    async get(path: string) {
      if (path.includes('/pulls?')) return { body: prList, link: null };
      if (path.includes('/pulls/1965/reviews')) return { body: [], link: null };
      if (path.includes('/pulls/1966/reviews')) return { body: [{ user: { login: 'aywengo' }, state: 'CHANGES_REQUESTED', commit_id: 'sha966' }], link: null };
      if (path.includes('/commits/sha965/check-runs')) {
        return { body: { check_runs: [
          { name: 'ci', status: 'completed', conclusion: 'failure' },
          { name: 'test (node 22.18.0)', status: 'completed', conclusion: 'failure' },
        ] }, link: null };
      }
      if (path.includes('/check-runs?')) return { body: { check_runs: [] }, link: null };
      return { body: [trusted, trusted2], link: null };
    },
    post: base.post,
    async postJson(_p: string, body: unknown) {
      const vars = (body as { variables: { number: number } }).variables;
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } } };
    },
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 966, 'the owner change request wins over the older red-ci PR');
});

test('#980: a PR authored by someone else with red ci is not selected', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const trusted = issue({ number: 965, user: { login: 'aywengo' } });
  const prList = [
    { number: 1965, user: { login: 'someone-else' }, created_at: '2026-10-15T22:35:00Z', head: { sha: 'sha965', ref: 'fix/issue-965-typecheck' } },
  ];
  const io = redCiIo({ failingJobs: [{ name: 'test (node 22.18.0)' }] }) as { get: (p: string) => Promise<unknown> };
  const origGet = io.get;
  io.get = async (path: string) => {
    if (path.includes('/pulls?')) return { body: prList, link: null };
    return origGet(path);
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'red ci on a foreign PR is not nightly resume work');
});

/** A temp XDG_STATE_HOME whose flake clock records 'e2e/retries a flaky request'. */
async function flakeHome(): Promise<string> {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./helpers.ts');
  const home = tempDir('nightly-flake-');
  mkdirSync(join(home, 'mercury', 'nightly'), { recursive: true });
  writeFileSync(join(home, 'mercury', 'nightly', 'e2e-flakes.json'), JSON.stringify({
    fp1: { test: 'e2e/retries a flaky request', error: 'timeout', nights: ['2026-10-16'] },
  }));
  return home;
}

test('#980: a failure confined to a known flake does not trigger a red-ci resume', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  // The exemption is decided from the failed job's LOG, not the job name or the check-run
  // output fields (#980 review r2).
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', log: '✖ e2e/retries a flaky request (12.3ms)' }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.notEqual(s.rung, 0, 'a known-flake-only red head waits for a human review instead of looping');
});

test('#980: loadFlakeTestNames rejects corrupt entries the flake-clock loader rejects (review r6)', async () => {
  const { loadFlakeTestNames } = await import('../.agents/skills/nightly/select.ts');
  const env = { XDG_STATE_HOME: '/unused' };
  const state = {
    ok: { test: 'e2e/retries a flaky request', error: 'timeout', nights: ['2026-10-16'] },
    // The record from the finding: valid JSON, but nights is null.
    nullNights: { test: 'e2e/superseded name', error: 'timeout', nights: null },
    missingError: { test: 'e2e/other test', nights: ['2026-10-16'] },
    numberNights: { test: 'e2e/other test', error: 'timeout', nights: [1] },
    emptyTest: { test: '', error: 'timeout', nights: ['2026-10-16'] },
    stringEntry: 'oops',
  };
  assert.deepEqual(
    loadFlakeTestNames(env, () => JSON.stringify(state)),
    ['e2e/retries a flaky request'],
    'only the fully-shaped entry yields a name',
  );
});

test('#980: a corrupt flake record does not suppress a red-ci resume (review r6)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./helpers.ts');
  const home = tempDir('nightly-flake-corrupt-');
  mkdirSync(join(home, 'mercury', 'nightly'), { recursive: true });
  // Valid JSON, corrupt entry: the job log names exactly this test, so an unvalidated loader
  // would exonerate the head — e2e.ts::loadFlakeState rejects this shape, the selector must too.
  writeFileSync(join(home, 'mercury', 'nightly', 'e2e-flakes.json'), JSON.stringify({
    fp1: { test: 'e2e/retries a flaky request', error: 'timeout', nights: null },
  }));
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', log: '✖ e2e/retries a flaky request (12.3ms)' }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'a corrupt record is not a recorded flake — the red head resumes');
  assert.equal(s.issue, 965);
});

test('#980: a real failure next to a known flake still resumes', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  const s = await runSelectorWith(redCiIo({
    failingJobs: [
      { name: 'test (node 22.18.0)', externalId: '9001', log: '✖ e2e/retries a flaky request (12.3ms)' },
      { name: 'plan-tracker' },
    ],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'the plan-tracker failure is real work');
  assert.match(s.reason, /plan-tracker/);
});

test('#980: a flake plus a real failure in the SAME job resumes', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{
      name: 'test (node 22.18.0)',
      externalId: '9001',
      log: [
        '✖ e2e/retries a flaky request (12.3ms)',
        '✖ e2e/schema rejects bad json (15.0ms)',
        'ℹ fail 2',
        '',
        '✖ failing tests:',
        '',
        'test at e2e/retries.test.ts:8:1',
        '✖ e2e/retries a flaky request (12.3ms)',
        '  AssertionError: expected 200 to be 429',
      ].join('\n'),
    }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'one real failure next to the flake in the same log resumes');
  assert.match(s.reason, /test \(node 22\.18\.0\)/);
});

test('#980: an unreadable job log is a real failure and resumes', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  // (a) the log endpoint answers non-2xx
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', logStatus: 404 }],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'a 404 job log is treated as real, never as a flake');
  // (b) the transport throws
  const s2 = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', logError: true }],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s2.rung, 0, 'a thrown log fetch is treated as real');
  // (c) no external_id: not an Actions job, there is no log to read
  const s3 = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)' }],
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s3.rung, 0, 'a job without an Actions id has no readable log');
});

test('#980: a job log in the raw Actions shape still classifies (line prefix, ##[] markers)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  // Every line of an Actions job log carries a `<ts>Z ` prefix; the runner's own `##[group]`
  // and `##[error]` lines are not test names.
  const log = [
    '2026-11-01T00:31:02.1234567Z ##[group]Run npm test',
    '2026-11-01T00:31:02.2345678Z > mercury@0.2.7 test',
    '2026-11-01T00:31:03.3456789Z ✖ e2e/retries a flaky request (12.3ms)',
    '2026-11-01T00:31:03.4567890Z ℹ fail 1',
    '2026-11-01T00:31:03.5678901Z ##[error]Process completed with exit code 1.',
  ].join('\n');
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', log }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.notEqual(s.rung, 0, 'the Actions line prefix must not hide the flake names');
});

test('#980: failingTestMentions reads the marker through the Actions log line prefix', async () => {
  const { failingTestMentions } = await import('../.agents/skills/nightly/select.ts');
  const log = [
    '2026-11-01T00:31:02.1234567Z ##[group]Run npm test',
    '2026-11-01T00:31:03.2345678Z ✖ e2e/retries a flaky request (12.3ms)',
    '2026-11-01T00:31:03.3456789Z not ok 5 - does the thing',
    '2026-11-01T00:31:03.4567890Z ##[error]Process completed with exit code 1.',
    '2026-11-01T00:31:03.5678901Z ✖ failing tests:',
  ].join('\n');
  assert.deepEqual(failingTestMentions(log), ['e2e/retries a flaky request', 'does the thing']);
});

test('#980: fetchJobLog returns null for a missing transport, a bad id or a non-2xx', async () => {
  const { fetchJobLog } = await import('../.agents/skills/nightly/select.ts');
  assert.equal(await fetchJobLog({}, 'aywengo/mercury', undefined), null, 'no getText: no log');
  assert.equal(await fetchJobLog({ async getText() { return { status: 200, text: 'x' }; } }, 'aywengo/mercury', 'not-a-number'), null, 'a non-numeric id is not a job log');
  assert.equal(await fetchJobLog({ async getText() { return { status: 404, text: 'Not Found' }; } }, 'aywengo/mercury', '123'), null, 'non-2xx is no log');
  const ok = await fetchJobLog({ async getText(p: string) { return { status: 200, text: `log of ${p}` }; } }, 'aywengo/mercury', '123');
  assert.equal(ok, 'log of /repos/aywengo/mercury/actions/jobs/123/logs');
});

test('#980: actionsJobId resolves the numeric job id from external_id or details_url (review r8)', async () => {
  const { actionsJobId } = await import('../.agents/skills/nightly/select.ts');
  const details = (job: string) => `https://github.com/aywengo/mercury/actions/runs/77/jobs/${job}`;
  // A numeric external_id (the Actions integration) is the job id, taken as-is.
  assert.equal(actionsJobId({ external_id: '9001' }), '9001', 'numeric external_id wins');
  // Numeric external_id wins even when details_url names a different job (the field is
  // authoritative when it is in the Actions shape).
  assert.equal(actionsJobId({ external_id: '9001', details_url: details('9002') }), '9001', 'numeric external_id outranks details_url');
  // An OPAQUE external_id (UUID) has no job log; the numeric id is recovered from details_url.
  assert.equal(actionsJobId({ external_id: '4f0c1a2e-77aa-4c8e-9b01-2c3d4e5f6a7b', details_url: details('9003') }), '9003', 'opaque external_id falls back to details_url');
  // No external_id at all: details_url is the only source.
  assert.equal(actionsJobId({ details_url: details('9004') }), '9004', 'details_url alone resolves the id');
  // Opaque external_id with NO details_url (or a non-Actions one) resolves to nothing.
  assert.equal(actionsJobId({ external_id: '4f0c1a2e-77aa-4c8e-9b01-2c3d4e5f6a7b' }), null, 'opaque external_id with no details_url is unresolvable');
  assert.equal(actionsJobId({ external_id: '4f0c1a2e-77aa-4c8e-9b01-2c3d4e5f6a7b', details_url: 'https://example.com/check/abc' }), null, 'a non-Actions details_url is unresolvable');
  assert.equal(actionsJobId({}), null, 'nothing to resolve is null');
});

test('#980: a flake-only job with an OPAQUE external_id still reads its log via details_url (review r8)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  // The check run is an Actions job, but its external_id is an opaque UUID (the integration
  // reports a non-numeric id). The numeric job id is only in details_url. The log names exactly
  // the recorded flake. Pre-r8, fetchJobLog rejected the UUID, the log was unreadable, and the
  // head was treated as a real failure (resume). Now the id resolves from details_url and the
  // flake-only head must NOT resume.
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{
      name: 'test (node 22.18.0)',
      externalId: '4f0c1a2e-77aa-4c8e-9b01-2c3d4e5f6a7b',
      detailsUrl: 'https://github.com/aywengo/mercury/actions/runs/77/jobs/9001',
      jobId: '9001',
      log: '✖ e2e/retries a flaky request (12.3ms)',
    }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.notEqual(s.rung, 0, 'an opaque external_id must not defeat the flake exemption — the job id resolves from details_url');
});

test('#980: a job whose job id CANNOT be resolved still resumes (fail closed, review r8)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  // Opaque external_id and no usable details_url: the job id is unresolvable, the log is
  // unreadable, and an unreadable log is a REAL failure — the head resumes. This pins that the
  // r8 fix does not turn an unresolvable id into a spurious flake exemption.
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{
      name: 'test (node 22.18.0)',
      externalId: '4f0c1a2e-77aa-4c8e-9b01-2c3d4e5f6a7b',
      detailsUrl: 'https://example.com/check/abc',
      log: '✖ e2e/retries a flaky request (12.3ms)',
    }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'an unresolvable job id leaves an unreadable log — the red head resumes');
  assert.equal(s.issue, 965);
});

test('#980: ladder ordering puts owner changes first, then red ci, then Copilot findings', () => {
  const c = [
    cand(issue({ number: 10, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 11, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 12, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
  ];
  const s = selectLadder(c, { ...TERMINAL, resume: [
    { issue: 10, prNumber: 100, headSha: 'a', state: 'findings', createdAt: '2026-10-01T00:00:00Z' },
    { issue: 12, prNumber: 102, headSha: 'c', state: 'red-ci', createdAt: '2026-10-06T00:00:00Z', failingJobs: 'test (node 24.x)' },
    { issue: 11, prNumber: 101, headSha: 'b', state: 'owner-changes', createdAt: '2026-10-05T00:00:00Z' },
  ] });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 11, 'owner change request first');
  const s2 = selectLadder(c, { ...TERMINAL, resume: [
    { issue: 10, prNumber: 100, headSha: 'a', state: 'findings', createdAt: '2026-10-01T00:00:00Z' },
    { issue: 12, prNumber: 102, headSha: 'c', state: 'red-ci', createdAt: '2026-10-06T00:00:00Z', failingJobs: 'test (node 24.x)' },
  ] });
  assert.equal(s2.issue, 12, 'red ci outranks older Copilot findings');
});

test('#980: redCiJobs pulls the failing job names under the required aggregate check', async () => {
  const { redCiJobs } = await import('../.agents/skills/nightly/select.ts');
  const runs = [
    { name: 'ci', status: 'completed', conclusion: 'failure' },
    { name: 'test (node 24.x)', status: 'completed', conclusion: 'failure' },
    { name: 'changes', status: 'completed', conclusion: 'success' },
    { name: 'docs-contract', status: 'completed', conclusion: 'skipped' },
  ];
  assert.deepEqual(redCiJobs(runs), ['test (node 24.x)']);
  assert.equal(redCiJobs([{ name: 'ci', status: 'in_progress', conclusion: null }]), null, 'in progress is not a signal');
  assert.equal(redCiJobs([{ name: 'ci', status: 'completed', conclusion: 'success' }]), null, 'green is not a signal');
  assert.equal(redCiJobs([{ name: 'test (node 24.x)', status: 'completed', conclusion: 'failure' }]), null, 'no aggregate check: no signal');
  // A job that timed out or was cancelled is a FAILING job: its unsuccessful conclusion does
  // not mean "wait" — only a still-running or unknown conclusion does (#980 review r1).
  assert.deepEqual(redCiJobs([
    { name: 'ci', status: 'completed', conclusion: 'failure' },
    { name: 'test (node 22.18.0)', status: 'completed', conclusion: 'timed_out' },
  ]), ['test (node 22.18.0)'], 'a timed-out job is a failing job');
  assert.deepEqual(redCiJobs([
    { name: 'ci', status: 'completed', conclusion: 'failure' },
    { name: 'uninstall', status: 'completed', conclusion: 'cancelled' },
  ]), ['uninstall'], 'a cancelled job is a failing job');
  assert.deepEqual(redCiJobs([
    { name: 'ci', status: 'completed', conclusion: 'failure' },
    { name: 'changes', status: 'completed', conclusion: 'success' },
  ]), [], 'failed aggregate, no nameable sibling: still a signal (the caller reports unknown job)');
});

test('#980: failingTestMentions parses only the failing-test markers of a full spec report', async () => {
  const { failingTestMentions } = await import('../.agents/skills/nightly/select.ts');
  // The full shape node --test prints (the shape test/nightlyE2e.test.ts represents, extended
  // with suite headings): suite lines, inline failures, the ℹ summary lines, the `✖ failing
  // tests:` heading and the detail blocks. Exactly the real failing test names come out — the
  // heading, the ▶ lines and the ℹ lines are not test names (#980 review r3).
  const log = [
    '▶ e2e/retries.test.ts',
    '✔ e2e/retries a known good request (1.1ms)',
    '✖ e2e/retries a flaky request (12.3ms)',
    '▶ e2e/schema.test.ts',
    '✖ e2e/schema rejects bad json (2.1ms)',
    'ℹ tests 4',
    'ℹ suites 2',
    'ℹ pass 1',
    'ℹ fail 2',
    'ℹ cancelled 0',
    '',
    '✖ failing tests:',
    '',
    'test at e2e/retries.test.ts:8:1',
    '✖ e2e/retries a flaky request (12.3ms)',
    '  AssertionError: expected 200 to be 429',
    '',
    'test at e2e/schema.test.ts:5:1',
    '✖ e2e/schema rejects bad json (2.1ms)',
    "  SyntaxError: Unexpected token '{'",
  ].join('\n');
  assert.deepEqual(failingTestMentions(log), ['e2e/retries a flaky request', 'e2e/schema rejects bad json']);
  // TAP shape: the not-ok lines are the names, deduplicated.
  assert.deepEqual(failingTestMentions('not ok 3 - does the thing\nnot ok 7 - does the thing\nok 1 - works (1ms)\n'), ['does the thing']);
});

test('#980: a capped check-runs scan fails the red-ci signal closed (no resume, issue stays reserved)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = redCiIo({ failingJobs: [{ name: 'test (node 22.18.0)' }] }) as { get: (p: string) => Promise<unknown> };
  const origGet = io.get;
  io.get = async (path: string) => {
    if (path.includes('/check-runs?')) return { body: { check_runs: [] }, link: '<https://api.github.com/repos/aywengo/mercury/commits/sha965/check-runs?per_page=100&page=2>; rel="next"' };
    return origGet(path);
  };
  const s = await runSelectorWith(io as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'unknown CI state never fakes a red-ci resume');
});

test('#980: the flake guard matches COMPLETE test names — a superset name is a real failure', async () => {
  const { isFlakeConfinedJob } = await import('../.agents/skills/nightly/select.ts');
  assert.equal(isFlakeConfinedJob('✖ retries a flaky request (1.0ms)\n', ['retries a flaky request']), true, 'the recorded name itself matches');
  assert.equal(isFlakeConfinedJob('✖ retries a flaky request with invalid credentials (1.0ms)\n', ['retries a flaky request']), false, 'a DISTINCT test whose name contains the flake is a real failure');
  assert.equal(
    isFlakeConfinedJob('✖ e2e/retries a flaky request (1.0ms)\n✖ e2e/retries a flaky request with invalid credentials (1.0ms)\n', ['e2e/retries a flaky request']),
    false,
    'the flake next to a distinct superset-named failure is not confined',
  );
});

test('#980: a path-shaped flake mention normalizes to the repo-relative recorded name', async () => {
  const { isFlakeConfinedJob } = await import('../.agents/skills/nightly/select.ts');
  // The spec reporter names a file-level failure by the file's path as invoked — the job log
  // carries the worktree's absolute path; the flake clock records the repo-relative path.
  assert.equal(
    isFlakeConfinedJob('✖ /Users/roman/worktrees/run_abc123/e2e/knowledge.test.ts (12.3ms)\n', ['e2e/knowledge.test.ts']),
    true,
    'a worktree-absolute path ends with the recorded path at a / segment boundary',
  );
  assert.equal(
    isFlakeConfinedJob('✖ e2e/knowledge.test.ts.extra (12.3ms)\n', ['e2e/knowledge.test.ts']),
    false,
    'a different file that merely contains the recorded name is not the flake',
  );
});

test('#980: a real failure whose name ends with a recorded flake name is not a flake (review r7)', async () => {
  const { isFlakeConfinedJob } = await import('../.agents/skills/nightly/select.ts');
  // The recorded flake is a bare test name; the real failure is a DISTINCT test whose name
  // ends with the flake's at a / segment boundary — the old suffix match exonerated it.
  assert.equal(
    isFlakeConfinedJob('✖ e2e/a context-free resume (1.0ms)\n', ['a context-free resume']),
    false,
    'a distinct test whose name ends with the recorded name is a real failure',
  );
  assert.equal(
    isFlakeConfinedJob('✖ a context-free resume (1.0ms)\n', ['a context-free resume']),
    true,
    'the recorded name itself still matches by full-name equality',
  );
});

test('#980: a red head whose only failure ends with a recorded flake name still resumes (review r7)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./helpers.ts');
  const home = tempDir('nightly-flake-exact-');
  mkdirSync(join(home, 'mercury', 'nightly'), { recursive: true });
  writeFileSync(join(home, 'mercury', 'nightly', 'e2e-flakes.json'), JSON.stringify({
    fp2: { test: 'a context-free resume', error: 'timeout', nights: ['2026-10-16'] },
  }));
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', log: '✖ e2e/a context-free resume (12.3ms)' }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'a distinct test whose name ends with the recorded flake name is a real failure');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /red ci on head sha965/);
});

// r7 blocker: the known-flake exemption must work through the PRODUCTION entry point. The
// previous round shipped the guard with every test driving runSelectorWith directly, so the
// NextIo -> runNext adapter wiring was never exercised and a flake-only red head would have
// kept resuming every night. Pinned behaviorally through runNext (the CLI's call path).
test('#980: runNext wires the job-log transport — a flake-only red head does not resume (review r7)', async () => {
  const { runNext } = await import('../.agents/skills/nightly/next.ts');
  const home = await flakeHome();
  const fixture = redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)', externalId: '9001', log: '✖ e2e/retries a flaky request (12.3ms)' }],
  });
  // runNext's NextIo surface adds the label writes; the dry run performs none of them.
  const io = {
    ...fixture,
    async postLabel() { throw new Error('postLabel must not run on a dry run'); },
    async deleteLabel() { throw new Error('deleteLabel must not run on a dry run'); },
  };
  const s = await runNext(io as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, { repo: 'aywengo/mercury', dryRun: true });
  assert.notEqual(s.rung, 0, 'a head failing only on a recorded flake must not resume through the production entry point');
});

test('next.ts realIo supplies getText (production flake-guard wiring, review r7)', async () => {
  // realIo is not exported; pin the contract the same way as postJson: the behavioral test
  // above proves the runNext path, this line proves the CLI's realIo feeds it.
  const src = await (await import('node:fs/promises')).readFile('.agents/skills/nightly/next.ts', 'utf8');
  assert.match(
    src,
    /getText: async \(path\) => await ghGetText\(path, token, JOB_LOG_MAX_BYTES\)/,
    'realIo must wire getText, or the known-flake exemption never takes effect outside tests',
  );
});

test('#980: an incomplete review scan does not suppress the red-ci signal (CI is not review evidence)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{ name: 'test (node 22.18.0)' }],
    threadsIncomplete: true,
  }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'a readable, completed failing ci check resumes even when the thread query is capped');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /red ci on head sha965/);
  // And no false signal in the other direction: a GREEN head with an incomplete review scan
  // still does not resume — unknown CI state waits.
  const s2 = await runSelectorWith(redCiIo({ ciConclusion: 'success', threadsIncomplete: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s2.rung, 0, 'no ci signal and incomplete review evidence: nothing to resume');
});

test('#980: a known-flake-plus-timeout job still resumes (a timeout is interrupted execution, not a flake)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const home = await flakeHome();
  // The log prints ONLY the known-flake marker — but the job concluded timed_out (it hung
  // after the flake), so the flake exemption does not apply.
  const s = await runSelectorWith(redCiIo({
    failingJobs: [{
      name: 'test (node 22.18.0)',
      conclusion: 'timed_out',
      externalId: '9001',
      log: '✖ e2e/retries a flaky request (12.3ms)',
    }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s.rung, 0, 'only a job concluded `failure` is eligible for the flake exemption');
  assert.match(s.reason, /test \(node 22\.18\.0\)/);
  // Same for a cancelled job.
  const s2 = await runSelectorWith(redCiIo({
    failingJobs: [{
      name: 'test (node 24.x)',
      conclusion: 'cancelled',
      externalId: '9002',
      log: '✖ e2e/retries a flaky request (12.3ms)',
    }],
  }) as never, { REPO: 'aywengo/mercury', XDG_STATE_HOME: home }, true);
  assert.equal(s2.rung, 0, 'a cancelled job is interrupted execution too');
});

test('#980: a job log past the cap is truncated evidence — no exemption, the job stays real', async () => {
  const { fetchJobLog, JOB_LOG_MAX_BYTES } = await import('../.agents/skills/nightly/select.ts');
  const big = '✖ e2e/retries a flaky request (12.3ms)\n' + 'x'.repeat(JOB_LOG_MAX_BYTES);
  const log = await fetchJobLog({ async getText() { return { status: 200, text: big }; } }, 'aywengo/mercury', '123');
  assert.equal(log, null, 'a body past JOB_LOG_MAX_BYTES is truncated: null, never a usable prefix');
});

test('#1010: the gate reports its STATE, so "passed" and "never checked" stop being the same value', async () => {
  const { e2eGate } = await import('../.agents/skills/nightly/select.ts');
  // The defect: an unprovisioned host passed rung 1 forever, and nothing said so. The answer stays
  // permissive (an unconfigured gate is a deliberate opt-out), but the STATE names it.
  assert.deepEqual(await e2eGate({}), { terminal: true, state: 'absent' });
  assert.deepEqual(await e2eGate({ MERCURY_API_URL: 'http://127.0.0.1:9' }), { terminal: false, state: 'half-configured' });
  assert.deepEqual(await e2eGate({ MERCURY_API_TOKEN: 't' }), { terminal: false, state: 'half-configured' });
  assert.deepEqual(
    await e2eGate({ MERCURY_API_URL: 'http://127.0.0.1:9', MERCURY_API_TOKEN: 't' }),
    { terminal: false, state: 'unevaluable' },
    'unreachable host: configured, and it could not be read',
  );
  // A reachable host with no e2e Run tonight: configured, and it was actually checked.
  const { createServer } = await import('node:http');
  const srv = createServer((_req, res) => { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ runs: [] })); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    assert.deepEqual(await e2eGate({ MERCURY_API_URL: url, MERCURY_API_TOKEN: 't' }), { terminal: true, state: 'configured' });
  } finally {
    srv.close();
  }
});

test('#1010: the selector carries the gate state into its answer', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const io = {
    get: async () => ({ body: [], link: null }),
    post: async () => true,
    del: async () => true,
  };
  const sel = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, true);
  assert.equal(sel.e2eGate, 'absent', 'a host without the two variables must say so in the answer');
});


// -- Conflicted head (rung 0, #1015): a nightly PR whose head is `mergeable_state: dirty`
// conflicts with main and can never merge as-is. It is resume work with no review and no CI
// verdict needed; `unknown` (not computed yet) and `clean` are not signals.

// Fixture shaped like the 2026-10-19 conflicted set: nightly PRs whose head's mergeable_state
// is the signal under test; no reviews, no Copilot threads, CI green unless redCi is set.
function conflictIo(opts: {
  /** The detail endpoint's mergeable_state for the first PR (default 'dirty'). The PR LIST
   *  response omits mergeable/mergeable_state entirely (measured 2026-11-03, #1099 r1) — the
   *  signal comes from the detail endpoint only. */
  mergeableState?: string;
  /** The first PR's author (default the nightly identity). */
  prUser?: string;
  /** The detail endpoint fetch throws: the conflict signal must fail closed. */
  detailError?: boolean;
  /** Capped thread query: the review scan is INCOMPLETE (#980 review r5 discipline). */
  threadsIncomplete?: boolean;
  /** Red ci on the head (the compound case: dirty AND red). */
  redCi?: boolean;
  /** A second, newer nightly PR carrying the owner's changes-requested review (acceptance 5). */
  ownerReviewOnSecond?: boolean;
}) {
  const trusted = issue({ number: 965, user: { login: 'aywengo' } });
  const prs = [
    { number: 1965, user: { login: opts.prUser ?? 'mercury-nightly' }, created_at: '2026-10-15T22:35:00Z', head: { sha: 'sha965', ref: 'fix/issue-965-typecheck' } },
  ];
  const issues = [trusted];
  if (opts.ownerReviewOnSecond) {
    prs.push({ number: 1966, user: { login: 'mercury-nightly' }, created_at: '2026-10-16T20:00:00Z', head: { sha: 'sha966', ref: 'fix/issue-966-other' } });
    issues.push(issue({ number: 966, user: { login: 'aywengo' } }));
  }
  const checkRuns = opts.redCi
    ? [
      { name: 'ci', status: 'completed', conclusion: 'failure' },
      { name: 'test (node 22.18.0)', status: 'completed', conclusion: 'failure' },
    ]
    : [{ name: 'ci', status: 'completed', conclusion: 'success' }];
  return {
    async get(path: string) {
      if (path.includes('/pulls?')) return { body: prs, link: null };
      if (path.includes('/pulls/1966/reviews')) {
        return { body: opts.ownerReviewOnSecond ? [{ user: { login: 'aywengo' }, state: 'CHANGES_REQUESTED', commit_id: 'sha966' }] : [], link: null };
      }
      if (path.includes('/pulls/1965/reviews')) return { body: [], link: null };
      if (path.includes('/check-runs?')) return { body: { check_runs: checkRuns }, link: null };
      const detail = path.match(/^\/repos\/aywengo\/mercury\/pulls\/(\d+)$/);
      if (detail) {
        if (opts.detailError) throw new Error('detail fetch failed');
        return { body: { mergeable_state: detail[1] === '1965' ? (opts.mergeableState ?? 'dirty') : 'clean' }, link: null };
      }
      return { body: issues, link: null };
    },
    async post() { return true; },
    async postJson() {
      if (opts.threadsIncomplete) {
        return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: true }, nodes: [] } } } } } };
      }
      return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } } } } };
    },
  };
}

test('#1015: a nightly PR with a conflicted (dirty) head resumes at rung 0, reason names the head sha', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({}) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'a conflicted head is resume work with no review and no CI verdict');
  assert.equal(s.issue, 965);
  assert.match(s.reason, /conflicted with main on head sha965/);
});

test('#1015: an unknown mergeable_state is not a signal (GitHub has not computed it yet)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ mergeableState: 'unknown' }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'unknown means "not computed yet", not "conflicted"; the next night re-reads it');
  assert.notEqual(s.issue, 965, 'the open PR reserves the issue from new work too');
});

test('#1015: a clean mergeable_state is not a signal', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ mergeableState: 'clean' }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'a clean head can merge; it is not resume work');
  assert.notEqual(s.issue, 965, 'the open PR reserves the issue from new work too');
});

test('#1015: a PR authored by someone else with a dirty head is not selected', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ prUser: 'someone-else' }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'the resume rung takes nightly-authored PRs only');
  assert.equal(s.rung, 3, 'a foreign dirty PR reserves nothing — the issue stays selectable as new work');
  assert.equal(s.issue, 965);
});

test('#1015: an owner change request on another PR outranks a dirty head', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ ownerReviewOnSecond: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 966, 'the owner review gates the merge and resumes first');
  assert.match(s.reason, /changes-requested/);
});

test('#1015: ladder ordering puts owner changes first, then conflicted and red ci (same tier, oldest first), then findings', () => {
  const c = [
    cand(issue({ number: 10, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 11, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 12, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
    cand(issue({ number: 13, labels: [{ name: 'nightly:ready' }] }), [labeled('aywengo', 'nightly:ready')]),
  ];
  const resume = [
    { issue: 10, prNumber: 100, headSha: 'a', state: 'findings' as const, createdAt: '2026-10-01T00:00:00Z' },
    { issue: 12, prNumber: 102, headSha: 'c', state: 'red-ci' as const, createdAt: '2026-10-06T00:00:00Z', failingJobs: 'test (node 24.x)' },
    { issue: 11, prNumber: 101, headSha: 'b', state: 'conflicted' as const, createdAt: '2026-10-03T00:00:00Z' },
    { issue: 13, prNumber: 103, headSha: 'd', state: 'owner-changes' as const, createdAt: '2026-10-07T00:00:00Z' },
  ];
  const s = selectLadder(c, { ...TERMINAL, resume });
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 13, 'owner change request first');
  const s2 = selectLadder(c, { ...TERMINAL, resume: resume.filter((r) => r.issue !== 13) });
  assert.equal(s2.issue, 11, 'the older conflicted head wins the shared tier with the red-ci PR');
  assert.match(s2.reason, /conflicted with main on head b/);
  const s3 = selectLadder(c, { ...TERMINAL, resume: resume.filter((r) => r.issue === 12 || r.issue === 10) });
  assert.equal(s3.issue, 12, 'red ci outranks older Copilot findings');
});

test('#1015: a conflicted head resumes even when the review scan is incomplete (the conflict is not review evidence)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ threadsIncomplete: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0, 'mergeable_state is PR-list metadata; an unreadable thread query does not hide a conflict');
  assert.equal(s.issue, 965);
});

test('#1015: a conflicted head that is also red reports the conflict (merging main resolves both)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ redCi: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.equal(s.rung, 0);
  assert.equal(s.issue, 965);
  assert.match(s.reason, /conflicted with main on head sha965/);
  assert.doesNotMatch(s.reason, /red ci/);
});

test('#1015: an unreadable PR detail fails the conflict signal closed (no resume, issue stays reserved)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const s = await runSelectorWith(conflictIo({ detailError: true }) as never, { REPO: 'aywengo/mercury' }, true);
  assert.notEqual(s.rung, 0, 'an unreadable detail response cannot establish a conflict');
  assert.notEqual(s.issue, 965, 'the open PR still reserves the issue from new work');
});
