// The task store Mercury gives the SDK, if the SDK's handler needs one (docs/a2a-design.md
// sections 6.4 and 11 decision 3).
//
// "Mercury's Run chain is the only task store." This adapter is how that rule survives contact with
// an SDK that wants one: every READ is a projection of persisted Run rows, and every WRITE is
// REFUSED. Nothing is held in memory, so there is no second copy of task state to disagree with the
// Run chain after a restart.
//
// The refusal is not a placeholder. A store that accepted `save` would be an SDK-owned task record
// written on the transport path -- exactly the "second store" the boundary rules forbid -- so
// refusing is the behaviour the design asks for, and it is loud (a 400-class A2A error) rather than
// silent.

import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import type { RunService } from '../runs/runService.ts';
import { toA2aTask } from './task.ts';
import { requireUser } from './user.ts';

export interface RunTaskStoreDeps {
  runService: RunService;
}

/**
 * `TaskStore` over `RunService`.
 *
 * `load` and `list` are reads through `RunService`, which is what makes them owner-scoped: the
 * caller's owner id comes from the authenticated call context, never from the request body, so an
 * A2A caller cannot read another owner's task by guessing an id.
 */
export function createRunTaskStore(deps: RunTaskStoreDeps): TaskStore {
  return {
    async save(_task: Task, _context: ServerCallContext): Promise<void> {
      throw new UnsupportedOperationError(
        'Mercury does not accept task writes from the A2A transport: the Run chain is the only task store.',
      );
    },

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const user = requireUser(context);
      const chain = deps.runService.getChain(taskId, user.ownerId, user.isAdmin);
      if (!chain) return undefined;
      const latest = chain[chain.length - 1]!;
      return toA2aTask(chain, { goal: deps.runService.getGoal(latest.id)?.status ?? null });
    },

    async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
      // A2 (section 6.6). Refused rather than answered partially: a `ListTasks` that silently
      // ignored its filters would look like an empty result set instead of an unimplemented call.
      throw new UnsupportedOperationError(`ListTasks is not implemented yet (pageSize ${params.pageSize ?? 'unset'}).`);
    },
  };
}
