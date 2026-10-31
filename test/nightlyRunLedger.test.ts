// The nightly-next Run ledger (#1024): `next.ts` records the claim it took and the terminal call
// it made, so the morning report can name a Run that claimed work and never called `finish` or
// `blocked`. The failure this closes: run_84a35e1f57ae4df4 committed and ended on a progress
// message, and nothing anywhere recorded that it had never finished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

test('#1024 review r1: an exit call given an env writes under that env (the ambient-home guard is the source pin below)', async () => {
  // The blocking finding: with an `env = process.env` default, every caller that forgot the
  // argument wrote to the HOST's real ledger -- and inside a nightly Run that meant `npm test`
  // closed the Run's own claim, so the report could never list it.
  // #1026: this test passes WITH OR WITHOUT that fix -- it calls finishIssue with an EXPLICIT
  // env, which shadows any default, so it only proves the explicit argument is honoured. It is
  // not the pin for "never the ambient home": that is the source assertion in the next test. If
  // the source pin is deleted, nothing behavioural catches the reintroduced default.
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
  // #1026: cheap guard, and it matches ONE spelling -- `env: NodeJS.ProcessEnv = process.env`
  // in the signature. A reintroduction spelled `env?: NodeJS.ProcessEnv` with
  // `env = env ?? process.env` in the body passes silently. Do not over-trust this pin, and do
  // not delete it thinking the behavioural test above covers the case: it does not.
  const src = readFileSync(new URL('../.agents/skills/nightly/next.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /export async function (finishIssue|blockIssue)\([^)]*env: NodeJS\.ProcessEnv = process\.env/);
});

test('#1026: concurrent ledger writers do not drop writes on a shared temp file', async () => {
  // #1026 item 4: the temp name was a fixed `${p}.tmp`. Two `next.ts` processes on one state home
  // raced that file, and the loser's renameSync threw ENOENT into the catch -- the claim or
  // terminal call was silently dropped. The per-pid temp name makes the rename own-writer-only.
  //
  // The race is between PROCESSES: saveRunLedger is fully synchronous, so one process cannot
  // interleave with itself. This spawns two real writers released by a barrier (the
  // crossProcess.test.ts pattern) and asserts on their failure counters: with a shared temp
  // name, a colliding rename ENOENTs and the writer reports failed > 0.
  //
  // Last-writer-wins on the read-modify-write is a separate property (no lock, by design), so
  // the assertions are that no write is DROPPED and the file stays a valid ledger -- not that
  // every entry of both writers survives.
  const stateHome = tempDir('mercury-ledger-race-');
  const barrier = join(stateHome, 'barrier');
  mkdirSync(barrier, { recursive: true });
  const writers = 2;
  const perWriter = 120;
  const children = [];
  for (let i = 0; i < writers; i++) {
    children.push(spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'ledger-writer.ts'), stateHome, String(perWriter), barrier], {
      env: { ...process.env, BARRIER_EXPECT: String(writers) },
    }));
  }
  const settled = await Promise.all(
    children.map(async (child, i) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { stdout += d; });
      child.stderr.on('data', (d: string) => { stderr += d; });
      const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) throw new Error(`writer ${i} produced no output (status ${status}): ${stderr.slice(0, 500)}`);
      return JSON.parse(line) as { pid: number; ok: boolean; cycles: number; failed: number; error?: string };
    }),
  );
  for (const r of settled) {
    assert.ok(r.ok, `writer ${r.pid} crashed: ${r.error}`);
    assert.equal(r.failed, 0, `writer ${r.pid} dropped ${r.failed} of ${r.cycles} ledger writes (shared temp file race)`);
  }
  // The file on disk must still be a valid, well-formed ledger: no torn or cross-writer-corrupted
  // JSON. A corrupt file reads as an EMPTY ledger (shape-validated read), so non-empty is the
  // parse-and-validate proof.
  const ledger = loadRunLedger({ XDG_STATE_HOME: stateHome });
  assert.ok(ledger.length > 0, 'the ledger is a valid non-empty file after the race');
});
