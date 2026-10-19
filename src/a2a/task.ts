// Run chain -> A2A `Task` (docs/a2a-design.md sections 6.4 and 6.5).
//
// The state itself is `toTaskState`'s job and lives in its own pure module. This file is the thin
// shell around it: identity (which Run is the task), the wire shape, and the two things a `Task`
// carries that a state does not -- the status timestamp and the status message.

import { Message, Part, Role, Task, TaskState } from '@a2a-js/sdk';
import type { GoalStatus, Run } from '../domain/types.ts';
import { chainState } from '../domain/runChain.ts';
import { toTaskState, type TaskStateName } from './taskState.ts';

/** The wire enum for each name in the mapping's closed union. Exhaustive by construction: adding a
 *  name to `TaskStateName` without adding it here is a type error, which is the point of keeping
 *  the union Mercury-local (section 6.5) rather than storing SDK values in the mapping. */
const TASK_STATE_VALUES: Record<TaskStateName, TaskState> = {
  TASK_STATE_SUBMITTED: TaskState.TASK_STATE_SUBMITTED,
  TASK_STATE_WORKING: TaskState.TASK_STATE_WORKING,
  TASK_STATE_INPUT_REQUIRED: TaskState.TASK_STATE_INPUT_REQUIRED,
  TASK_STATE_COMPLETED: TaskState.TASK_STATE_COMPLETED,
  TASK_STATE_FAILED: TaskState.TASK_STATE_FAILED,
  TASK_STATE_CANCELED: TaskState.TASK_STATE_CANCELED,
};

/** The root attempt: the task id is the ROOT Run's id, and it stays that id for every retry
 *  (section 6.4). Falls back to the oldest row when a chain somehow carries no root, because a
 *  reader that cannot name the task is worse than one that names it approximately. */
function rootOf(chain: readonly Run[]): Run {
  return chain.find((run) => run.retryOf === null || run.retryOf === undefined) ?? chain[0]!;
}

/**
 * A status message is a `Message`, not a string: the mapping states a REASON ("timed out", a
 * recorded error), and the spec's carrier for it is an agent-role message with one text part.
 * Dropping the reason instead would lose the only human-readable explanation of a failure.
 */
function statusMessage(taskId: string, reason: string): Message {
  const part: Part = { content: { $case: 'text', value: reason }, metadata: undefined, filename: '', mediaType: 'text/plain' };
  return {
    messageId: `status:${taskId}`,
    contextId: taskId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [part],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * The chain as the A2A `Task` a client sees.
 *
 * `history` is empty and `artifacts` is empty: v1 returns the task's current state, and the
 * caller's own text is not echoed back as agent output (section 6.7). `contextId` is the task id
 * -- v1 generates one context per task and returns it, which the spec allows and which is the only
 * honest answer when nothing persists a separate context (section 6.4, deferred decision 5).
 */
export function toA2aTask(
  chain: readonly Run[],
  opts: { goal?: GoalStatus | null } = {},
): Task {
  const { latest, retryPending } = chainState(chain);
  const root = rootOf(chain);
  const mapped = toTaskState({ chain, goal: opts.goal ?? null });
  const status = {
    state: TASK_STATE_VALUES[mapped.state],
    message: mapped.message === undefined ? undefined : statusMessage(root.id, mapped.message),
    timestamp: mapped.timestamp,
  };
  return {
    id: root.id,
    contextId: root.id,
    status,
    artifacts: [],
    history: [],
    // The chain's own bookkeeping, for a caller debugging a task without access to Mercury: which
    // attempt is speaking, and whether a retry is still coming. Goal status rides along as metadata
    // exactly as the mapping reports it -- never as the task state (section 6.5).
    metadata: {
      mercury: {
        attempt: latest.attempt,
        runId: latest.id,
        retryPending,
        ...(mapped.metadata ?? {}),
      },
    },
  };
}
