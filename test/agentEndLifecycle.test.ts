/**
 * Issue #592: the adapter-lifecycle event `agent.end` must stop the worker's "unknown type"
 * warning from firing on every successful Run, WITHOUT weakening the warning for the case it
 * exists for.
 *
 * `agent.end` is Mercury's own translation of the harness `agent_end` frame
 * (src/adapters/eventTranslation.ts). Every adapter consumes it to settle its exit promise and
 * pushes it into the event stream only because all harness events share one translation path. It
 * is not a Run event and nothing persists it -- so the worker logged a warning on every Run that
 * reached `agent_end`. Three of three real PrimeAgent Runs in an end-to-end pass logged it.
 *
 * That warning is the boundary defence for issue #50: `ev.type` is agent- and repository-controlled
 * and routes.ts writes it raw into `event: <type>` in an SSE frame, so a type carrying a blank line
 * injects frames into every subscriber. A warning that fires on every successful Run is not a
 * warning, so the fix has to be directional. Both directions are asserted here: the routine signal
 * goes quiet, and the hostile one still shouts. The second test is the one that matters -- without
 * it this change is indistinguishable from a suppression list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { isLifecycleEventType, isEventType } from '../src/domain/types.ts';

const DROP_MSG = 'dropping agent event with an unknown type';

/** Run one scripted fake and return the persisted event types plus every captured log line. */
async function runScripted(script: { event: { type: string; payload?: unknown } }[]) {
  const repo = makeGitRepo(tempDir('mercury-lifecycle-'));
  const logs: { level: string; msg: string }[] = [];
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: repo,
    fakeScript: script,
    logCapture: (level: string, msg: string) => logs.push({ level, msg }),
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'exercise the event boundary',
      agent: 'fake',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    return { types: env.events.list(run.id).map((e) => e.type), logs };
  } finally {
    env.close();
  }
}

test('agent.end is consumed quietly instead of warning on every successful Run', async () => {
  const { types, logs } = await runScripted([
    { event: { type: 'agent.message', payload: { text: 'done' } } },
    // What every real harness produces at the end of a turn.
    { event: { type: 'agent.end', payload: { code: 0 } } },
  ]);

  assert.deepEqual(
    logs.filter((l) => l.msg === DROP_MSG).map((l) => l.level),
    [],
    'a routine lifecycle event must not raise the injection warning',
  );
  // Level, not just message. Asserting only the message would let `log.debug` become `log.warn` and
  // still pass -- which re-creates the every-Run operator-visible line this issue exists to remove.
  // Found by review as the one mutation the first draft survived.
  const lifecycle = logs.filter((l) => l.msg === 'adapter lifecycle event consumed, not persisted');
  assert.equal(lifecycle.length, 1, 'lifecycle consumption should be recorded once');
  assert.equal(lifecycle[0].level, 'debug',
    'a routine lifecycle event must be debug, not warn -- warn is the bug being fixed');

  // Quiet is not the same as persisted: the Run's own terminal events already say what happened.
  assert.ok(!types.includes('agent.end'), 'agent.end must not be persisted as a Run event');
  assert.ok(types.includes('agent.message'));
  assert.ok(types.includes('run.completed'));
});

test('a hostile event type still warns and is still not persisted', async () => {
  // The attack from issue #50: a type carrying a blank line would inject an arbitrary SSE frame.
  const hostile = 'agent.end\n\nevent: run.completed';
  assert.ok(!isLifecycleEventType(hostile), 'the lifecycle set must not match a crafted type');
  assert.ok(!isEventType(hostile));

  const { types, logs } = await runScripted([
    { event: { type: 'agent.end', payload: { code: 0 } } },
    { event: { type: hostile, payload: {} } },
  ]);

  const drops = logs.filter((l) => l.msg === DROP_MSG);
  assert.equal(drops.length, 1, 'exactly the hostile type may warn, not the lifecycle one');
  assert.equal(drops[0].level, 'warn');
  assert.ok(!types.includes(hostile), 'the hostile type must never reach the event store');
  assert.ok(!types.includes('agent.end'));
});
