// The nightly-next Run ledger (#1024): `next.ts` records the claim it took and the terminal call
// it made, so the morning report can name a Run that claimed work and never called `finish` or
// `blocked`. The failure this closes: run_84a35e1f57ae4df4 committed and ended on a progress
// message, and nothing anywhere recorded that it had never finished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runNext, finishIssue, blockIssue, type NextIo } from '../.agents/skills/nightly/next.ts';
import { loadRunLedger, recordRunClaim, recordRunTerminal, runLedgerPath, RUN_LEDGER_CAP } from '../.agents/skills/nightly/shared.ts';
import { tempDir } from './helpers.ts';
import type { GhIssue, LabelEvent } from '../.agents/skills/nightly/select.ts';

const REPO = 'aywengo/mercury';

/** An io that lists one trusted @aywengo bug and accepts every write. */
function ioWith(issues: GhIssue[]): NextIo {
  const claimEvents = new Map<number, LabelEvent[]>();
  return {
    async get(path) {
      if (path.startsWith(`/repos/${REPO}/issues?`)) return { body: issues, status: 200, link: null };
      const tl = path.match(/\/issues\/(\d+)\/timeline/);
      if (tl) {
        const n = Number(tl[1]);
        // The trust rule reads the label ACTOR from the timeline (#801): a `nightly:ready` label
        // applied by @aywengo is what makes the issue rung 1.
        return {
          body: [
            { event: 'labeled', actor: { login: 'aywengo' }, label: { name: 'nightly:ready' } } as unknown as LabelEvent,
            ...(claimEvents.get(n) ?? []),
          ],
          status: 200,
          link: null,
        };
      }
      return { body: [], status: 200, link: null };
    },
    async post() { return { body: {}, status: 201 }; },
    async postLabel(path, body) {
      const m = path.match(/\/issues\/(\d+)\/labels$/);
      if (m) {
        const n = Number(m[1]);
        claimEvents.set(n, [...(claimEvents.get(n) ?? []), { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: (body as { labels: string[] }).labels[0] } } as unknown as LabelEvent]);
      }
      return true;
    },
    async deleteLabel() { return true; },
    async patch() { return { body: {}, status: 200 }; },
  };
}

function trustedIssue(n: number): GhIssue {
  return {
    number: n, title: `bug ${n}`, user: { login: 'aywengo' },
    labels: [{ name: 'nightly:ready' }],
    created_at: '2026-09-20T00:00:00Z',
  } as unknown as GhIssue;
}

test('#1024: next.ts run records the claim (run id, issue, worktree)', async () => {
  const stateHome = tempDir('mercury-ledger-run-');
  const env = { GH_TOKEN: 't', XDG_STATE_HOME: stateHome, MERCURY_RUN_ID: 'run_abc' };
  const out = await runNext(ioWith([trustedIssue(1024)]), env, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 1);
  const ledger = loadRunLedger(env);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.runId, 'run_abc');
  assert.equal(ledger[0]!.issue, 1024);
  assert.equal(ledger[0]!.cwd, process.cwd(), 'the worktree path is recorded for recovery');
  assert.equal(ledger[0]!.terminal, undefined, 'nothing has exited yet');
});

test('#1024: --dry-run records nothing (it claims nothing)', async () => {
  const stateHome = tempDir('mercury-ledger-dry-');
  const env = { GH_TOKEN: 't', XDG_STATE_HOME: stateHome, MERCURY_RUN_ID: 'run_dry' };
  await runNext(ioWith([trustedIssue(1024)]), env, { repo: REPO, dryRun: true });
  assert.deepEqual(loadRunLedger(env), []);
});

test('#1024: finish and blocked are terminal calls; a progress message never is', async () => {
  const stateHome = tempDir('mercury-ledger-exit-');
  const env = { GH_TOKEN: 't', XDG_STATE_HOME: stateHome, MERCURY_RUN_ID: 'run_finish' };
  recordRunClaim(env, { runId: 'run_finish', issue: 7, cwd: '/ws/a' });
  recordRunClaim(env, { runId: 'run_blocked', issue: 8, cwd: '/ws/b' });
  recordRunClaim(env, { runId: 'run_silent', issue: 9, cwd: '/ws/c' });

  await finishIssue(ioWith([]), { repo: REPO, issue: 7 }, { ...env, MERCURY_RUN_ID: 'run_finish' });
  await blockIssue(ioWith([]), { repo: REPO, issue: 8, reason: 'needs a decision' }, { ...env, MERCURY_RUN_ID: 'run_blocked' });

  const byId = new Map(loadRunLedger(env).map((e) => [e.runId, e]));
  assert.equal(byId.get('run_finish')!.terminal, 'finish');
  assert.equal(byId.get('run_blocked')!.terminal, 'blocked');
  assert.equal(byId.get('run_silent')!.terminal, undefined, 'a Run that stopped mid-sentence stays open in the ledger');
});

test('#1024: without MERCURY_RUN_ID the ledger is untouched (manual invocations, older hosts)', async () => {
  const stateHome = tempDir('mercury-ledger-norun-');
  const env = { GH_TOKEN: 't', XDG_STATE_HOME: stateHome };
  const out = await runNext(ioWith([trustedIssue(1024)]), env, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 1, 'the selection itself still works');
  assert.deepEqual(loadRunLedger(env), []);
  assert.equal(recordRunTerminal(env, undefined, 'finish'), false);
});

test('#1024: an unwritable state home never fails the exit path', async () => {
  // HOME=/ is the "cannot locate a state directory" case: recordRunTerminal must return false,
  // and the claim removal must still happen (the caller's result is what matters).
  const res = await finishIssue(ioWith([]), { repo: REPO, issue: 7 }, { MERCURY_RUN_ID: 'run_x', HOME: '/' });
  assert.equal(res.removed, true);
  assert.equal(recordRunClaim({ HOME: '/' }, { runId: 'run_x', issue: 7 }), false);
});

test('#1024: the ledger is capped, newest entries kept', () => {
  const stateHome = tempDir('mercury-ledger-cap-');
  const env = { XDG_STATE_HOME: stateHome };
  for (let i = 0; i < RUN_LEDGER_CAP + 5; i++) {
    recordRunClaim(env, { runId: `run_${i}`, issue: i + 1, at: new Date(Date.UTC(2026, 8, 26, 0, i)) });
  }
  const ledger = loadRunLedger(env);
  assert.equal(ledger.length, RUN_LEDGER_CAP);
  assert.equal(ledger[ledger.length - 1]!.runId, `run_${RUN_LEDGER_CAP + 4}`);
  assert.ok(runLedgerPath(env).endsWith('/mercury/nightly/run-ledger.json'));
});

test('#1024 review r1: an exit call writes only under the env it is given, never the ambient home', async () => {
  // The blocking finding: with an `env = process.env` default, every caller that forgot the
  // argument wrote to the HOST's real ledger -- and inside a nightly Run that meant `npm test`
  // closed the Run's own claim, so the report could never list it.
  const own = tempDir('mercury-ledger-own-');
  const other = tempDir('mercury-ledger-other-');
  recordRunClaim({ XDG_STATE_HOME: own }, { runId: 'run_a', issue: 5, cwd: '/ws/a' });
  await finishIssue(ioWith([]), { repo: REPO, issue: 5 }, { XDG_STATE_HOME: other, MERCURY_RUN_ID: 'run_a' });
  assert.equal(loadRunLedger({ XDG_STATE_HOME: own })[0]!.terminal, undefined,
    'the Run\'s own claim is untouched by an exit call that was given a different env');
  assert.deepEqual(loadRunLedger({ XDG_STATE_HOME: other }), [], 'and nothing is invented in the other home');
});

test('#1024 review r1: the exit paths have no process.env default', () => {
  // Pinned in source, because the failure mode is a call site that silently writes to the host's
  // ledger. A default is the mechanism; removing it is the fix.
  const src = readFileSync(new URL('../.agents/skills/nightly/next.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /export async function (finishIssue|blockIssue)\([^)]*env: NodeJS\.ProcessEnv = process\.env/);
});
