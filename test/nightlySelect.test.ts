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

test('rung 2: a trusted-author enhancement issue is selected, priority then age (#800)', () => {
  const older = issue({ number: 11, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }], created_at: '2026-09-21T00:00:00Z' });
  const newerHigh = issue({ number: 12, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }, { name: 'priority: high' }], created_at: '2026-09-23T00:00:00Z' });
  const s = selectLadder([cand(older), cand(newerHigh)], TERMINAL);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 12, 'priority: high beats age inside the rung');
  assert.match(s.reason, /enhancement issue #12/);
  const s2 = selectLadder([cand(older)], TERMINAL);
  assert.equal(s2.issue, 11, 'then oldest first');
  assert.match(s2.reason, /filed by @aywengo/);
});

test('rung 2: an enhancement label from an unverified actor on a foreign issue is NOT eligible (#800)', () => {
  // Same discipline as nightly:ready (#764): a label anyone can apply is not provenance. A
  // foreign-authored issue with a foreign-applied enhancement label stays out of the ladder.
  const foreign = issue({ number: 13, user: { login: 'random-dev' }, labels: [{ name: 'enhancement' }] });
  const s = selectLadder([cand(foreign, [labeled('random-dev', 'enhancement')])], TERMINAL);
  assert.equal(s.rung === 'none' || s.rung === 4, true, 'falls through to the docs rung, never rung 2');
});

test('rung 2: an @aywengo-applied enhancement label trusts a foreign-author issue (#800)', () => {
  const nightlyAuthored = issue({ number: 14, user: { login: 'mercury-nightly' }, labels: [{ name: 'enhancement' }] });
  const s = selectLadder([cand(nightlyAuthored, [labeled('aywengo', 'enhancement')])], TERMINAL);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 14);
  assert.match(s.reason, /labeled enhancement by @aywengo/);
});

test('rung 2 keeps its place after rung 1: ready still wins over enhancement (#800)', () => {
  const enh = issue({ number: 15, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }], created_at: '2026-09-20T00:00:00Z' });
  const ready = issue({ number: 16, labels: [{ name: 'nightly:ready' }], created_at: '2026-09-25T00:00:00Z' });
  const s = selectLadder([cand(enh), cand(ready, [labeled('aywengo', 'nightly:ready')])], TERMINAL);
  assert.equal(s.rung, 1);
  assert.equal(s.issue, 16);
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
