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
  assert.equal(s.rung === 'none' || s.rung === 3, true);
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
  assert.equal(sForeign.rung === 'none' || sForeign.rung === 3, true);

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
  // also not rung 2 (rung 2 requires @aywengo authorship) — it lands on rung 3/none.
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
  const io = {
    async get(path: string) {
      events.push(`get ${path}`);
      return { body: [issue({ number: 60, user: { login: 'aywengo' } })], link: null };
    },
    async post(path: string) {
      events.push(`post ${path}`);
      return true;
    },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.equal(s.rung, 2);
  assert.equal(s.issue, 60, 'the claimed issue is returned');
  assert.deepEqual(events.filter((e) => e.startsWith('post')), [
    'post /repos/aywengo/mercury/issues/60/labels',
  ], 'exactly one claim POST in the normal case');
  assert.ok(events.indexOf('post /repos/aywengo/mercury/issues/60/labels') !== -1, 'the claim is issued before runSelectorWith resolves');
  assert.match(s.reason, /#60/);
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
  assert.equal(s.rung, 2, 'the foreign e2e issue is not eligible; the @aywengo issue is rung 2');
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

test('runSelectorWith re-selects only when GitHub says the label was already there (422 racer)', async () => {
  const { runSelectorWith } = await import('../.agents/skills/nightly/select.ts');
  const posts: string[] = [];
  let first = true;
  const io = {
    async get() { return { body: [issue({ number: 62, user: { login: 'aywengo' } }), issue({ number: 63, user: { login: 'aywengo' } })], link: null }; },
    async post(path: string) {
      posts.push(path);
      if (first) { first = false; return false; } // 422: a racer already claimed #62
      return true;
    },
  };
  const s = await runSelectorWith(io, { REPO: 'aywengo/mercury' }, false);
  assert.deepEqual(posts, [
    '/repos/aywengo/mercury/issues/62/labels',
    '/repos/aywengo/mercury/issues/63/labels',
  ], 'the racer-taken candidate is dropped, the next one is claimed');
  assert.equal(s.issue, 63);
  assert.equal(s.rung, 2);
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
  const io = {
    async get(path: string) {
      paths.push(path);
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
  assert.equal(paths.filter((p) => p.startsWith('/repos/')).length, 2, 'both pages fetched');
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
  // A capped walk (always another page) fails closed: no claim, rung 3/none, not trusted.
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

test('a capped open-issue list reports rung 3, never a false none (round-9 review)', async () => {
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
  assert.equal(s.rung, 3, 'a capped walk means open items exist beyond the cap: docs rung, not none');
  assert.equal(paths.length, 10, 'the walk stopped at the cap');
});
