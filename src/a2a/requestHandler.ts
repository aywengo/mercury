// The A2A request handler, driven over `RunService` (docs/a2a-design.md sections 6.4, 6.6, 11
// decision 3).
//
// The SDK's transport layer (the Express REST binding) is the only thing that knows about HTTP;
// this is the seam underneath it, and it is where every A2A operation meets Mercury's own model.
// No SDK task store is instantiated here, and no SDK state is kept: a task IS a Run chain, read
// through `RunService` on every call, so a restart loses nothing.
//
// A1 implements SendMessage (new task), GetTask, CancelTask and the extended card. Everything else
// is refused with the error the spec defines for it rather than answered partially -- an operation
// that quietly returns nothing is indistinguishable from one that legitimately found nothing.

import {
  ContentTypeNotSupportedError,
  ExtensionSupportRequiredError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import type { AgentCard, CancelTaskRequest, GetExtendedAgentCardRequest, GetTaskRequest, ListTasksRequest, ListTasksResponse, Message, Part, SendMessageRequest, StreamResponse, Task, TaskPushNotificationConfig, GetTaskPushNotificationConfigRequest, ListTaskPushNotificationConfigsRequest, ListTaskPushNotificationConfigsResponse, DeleteTaskPushNotificationConfigRequest, SubscribeToTaskRequest } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { chainState } from '../domain/runChain.ts';
import { NotFoundError, ConflictError } from '../domain/errors.ts';
import { buildExtendedAgentCard, buildPublicAgentCard } from './agentCard.ts';
import { A2A_SKILL_ID_KEY, A2A_SKILL_SELECTION_EXTENSION, skillsForOwner, type A2aDeps, type A2aExposedSkill } from './config.ts';
import { toA2aTask } from './task.ts';
import { requireUser } from './user.ts';

/** How often a blocking SendMessage re-reads the chain. Short enough that a fast Run does not wait
 *  a poll interval after finishing, long enough not to spin the CPU of a server hosting many. */
const SETTLE_POLL_MS = 25;
/** Added to the Run's own `maxDurationMs` for the blocking wait. Every Run is bounded, so the wait
 *  is bounded by construction (section 6.6); the margin covers the queue-to-terminal gap. */
const SETTLE_MARGIN_MS = 5_000;

export function createA2aRequestHandler(deps: A2aDeps): A2ARequestHandler {
  const { runService, config, version } = deps;

  return {
    async getAgentCard(): Promise<AgentCard> {
      return buildPublicAgentCard(config, version);
    },

    async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest, context: ServerCallContext): Promise<AgentCard> {
      const user = requireUser(context);
      return buildExtendedAgentCard(config, version, skillsForOwner(config, user.ownerId));
    },

    async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
      const user = requireUser(context);
      const message = params.message;
      if (!message) throw new RequestMalformedError('SendMessage requires a message.');

      // A `taskId` means "continue this task". Mercury's only mid-run channel is input on an
      // interrupted Run, which is A1; every other case is `UnsupportedOperationError` by section
      // 6.6. Refusing all of them now is honest -- answering with a fresh task would silently
      // duplicate work the caller believes it is continuing.
      if (message.taskId) {
        throw new UnsupportedOperationError(
          `Continuing an existing task (${message.taskId}) is not implemented yet; send a new task.`,
        );
      }

      // Section 6.4: v1 generates one contextId per task, so a caller-supplied one cannot be
      // honoured. Accepting it would create the Run and then answer with a DIFFERENT context --
      // silently doing work in a context the caller believes it chose.
      if (message.contextId) {
        throw new RequestMalformedError(
          'A new task may not carry a contextId: Mercury generates one per task and cannot honour a caller-supplied one (docs/a2a-design.md section 6.4).',
        );
      }

      const skill = resolveSkill(config, user.ownerId, message, context);
      const text = textOf(message);
      const limit = skill.inputMaxChars ?? 8000;
      if (text.length > limit) {
        throw new RequestMalformedError(`Input is ${text.length} characters; this skill accepts at most ${limit}.`);
      }

      const run = runService.create({
        ownerId: user.ownerId,
        // A replacement FUNCTION, not a string: `String.replace` interprets `$&`, `$$`, `` $` ``
        // and `$'` in a string replacement, so caller text containing any of them would reach the
        // agent mangled -- and this is a coding agent, where a `$&` in a regex or a `$$` in a shell
        // snippet is ordinary. The function returns the text literally.
        task: skill.template.task.replace('{{input}}', () => text),
        repository: skill.template.repository,
        agent: skill.template.agent,
        constraints: skill.template.constraints,
        // The server's own provenance stamp (section 6.4, #988): no request body can set it, and
        // it is what makes ListTasks "this caller's A2A chains" rather than "every Run it owns".
        origin: { kind: 'a2a', ref: skill.id },
        // The caller's own message id IS the idempotency key (section 6.4), so a retry of the same
        // request returns the same task instead of creating a second Run for the same work.
        idempotencyKey: `a2a:${skill.id}:${message.messageId}`,
      });

      if (params.configuration?.returnImmediately === true) {
        return taskFor(runService, run.id, user.ownerId, user.isAdmin);
      }
      await waitForSettled(
        runService, run.id, user.ownerId, user.isAdmin,
        run.constraints.maxDurationMs, run.constraints.maxRetries,
      );
      return taskFor(runService, run.id, user.ownerId, user.isAdmin);
    },

    async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> {
      throw new UnsupportedOperationError('SendStreamingMessage is not implemented yet (A2).');
      yield undefined as never;
    },

    async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
      const user = requireUser(context);
      const chain = runService.getChain(params.id, user.ownerId, user.isAdmin);
      if (!chain) throw new TaskNotFoundError(`No task ${params.id}.`);
      return toA2aTask(chain, { goal: runService.getGoal(chain[chain.length - 1]!.id)?.status ?? null });
    },

    async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
      const user = requireUser(context);
      const chain = runService.getChain(params.id, user.ownerId, user.isAdmin);
      if (!chain) throw new TaskNotFoundError(`No task ${params.id}.`);
      const latest = chain[chain.length - 1]!;
      try {
        // Cancel the LATEST attempt (section 6.6): cancelling the root of a chain that has already
        // retried would report a task as cancelled while its current attempt kept running.
        runService.cancel(latest.id, user.ownerId, user.isAdmin);
      } catch (err) {
        if (err instanceof ConflictError) throw new TaskNotCancelableError(err.message);
        if (err instanceof NotFoundError) throw new TaskNotFoundError(err.message);
        throw err;
      }
      return taskFor(runService, chain[0]!.id, user.ownerId, user.isAdmin);
    },

    async listTasks(_params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
      throw new UnsupportedOperationError('ListTasks is not implemented yet (A2).');
    },

    // Push notifications are out of scope entirely, and the card says so
    // (`capabilities.pushNotifications: false`). The spec's error for that is the same for all four
    // operations, so they are answered in one place rather than four near-copies.
    async createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
      throw new PushNotificationNotSupportedError('Mercury does not support A2A push notifications.');
    },
    async getTaskPushNotificationConfig(_params: GetTaskPushNotificationConfigRequest): Promise<TaskPushNotificationConfig> {
      throw new PushNotificationNotSupportedError('Mercury does not support A2A push notifications.');
    },
    async listTaskPushNotificationConfigs(_params: ListTaskPushNotificationConfigsRequest): Promise<ListTaskPushNotificationConfigsResponse> {
      throw new PushNotificationNotSupportedError('Mercury does not support A2A push notifications.');
    },
    async deleteTaskPushNotificationConfig(_params: DeleteTaskPushNotificationConfigRequest): Promise<void> {
      throw new PushNotificationNotSupportedError('Mercury does not support A2A push notifications.');
    },

    async *resubscribe(_params: SubscribeToTaskRequest): AsyncGenerator<StreamResponse, void, undefined> {
      throw new UnsupportedOperationError('SubscribeToTask is not implemented yet (A2).');
      yield undefined as never;
    },
  };
}

function taskFor(runService: A2aDeps['runService'], taskId: string, ownerId: string, isAdmin: boolean): Task {
  const chain = runService.getChain(taskId, ownerId, isAdmin);
  if (!chain) throw new TaskNotFoundError(`No task ${taskId}.`);
  return toA2aTask(chain, { goal: runService.getGoal(chain[chain.length - 1]!.id)?.status ?? null });
}

/**
 * Which skill the caller asked for, and whether it is allowed to ask.
 *
 * A skill the caller may not use answers exactly as an unknown skill does (section 6.2): a
 * different error for "exists but not yours" would let an outsider enumerate the catalog.
 */
function resolveSkill(config: A2aDeps['config'], ownerId: string, message: Message, context: ServerCallContext): A2aExposedSkill {
  const declared = context.requestedExtensions ?? [];
  if (!declared.includes(A2A_SKILL_SELECTION_EXTENSION)) {
    throw new ExtensionSupportRequiredError(
      `This agent requires the skill-selection extension ${A2A_SKILL_SELECTION_EXTENSION}: pass the skill id in message.metadata.${A2A_SKILL_ID_KEY}.`,
    );
  }
  context.addActivatedExtension(A2A_SKILL_SELECTION_EXTENSION);
  const skillId = message.metadata?.[A2A_SKILL_ID_KEY];
  if (typeof skillId !== 'string' || skillId.length === 0) {
    throw new RequestMalformedError(`message.metadata.${A2A_SKILL_ID_KEY} must be the id of an exposed skill.`);
  }
  const skill = skillsForOwner(config, ownerId).find((candidate) => candidate.id === skillId);
  if (!skill) throw new RequestMalformedError(`Unknown skill '${skillId}'.`);
  return skill;
}

/** The caller's text parts, joined. Non-text parts are refused rather than dropped: silently
 *  discarding a caller's input is how a Run gets asked to do something nobody said. */
function textOf(message: Message): string {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
    else if (part.content !== undefined) {
      throw new ContentTypeNotSupportedError(`Only text parts are accepted; got '${part.content.$case}'.`);
    }
  }
  if (texts.length === 0) throw new RequestMalformedError('The message carried no text part.');
  return texts.join('\n');
}

/** Blocking SendMessage (section 6.6): wait until no further attempt will be made, or the Run is
 *  waiting for input. Bounded by the Run's own deadline plus a margin, so a blocking call cannot
 *  outlive the Run it is waiting on. */
async function waitForSettled(
  runService: A2aDeps['runService'],
  taskId: string,
  ownerId: string,
  isAdmin: boolean,
  maxDurationMs: number,
  maxRetries: number,
): Promise<void> {
  // Bounded per ALLOWED ATTEMPT, not per Run: the wait now covers a retry backoff, and a chain may
  // make `maxRetries + 1` attempts. Every attempt is bounded by its own `maxDurationMs`, so the
  // whole wait still cannot outlive the work it is waiting on.
  const attempts = Math.max(1, maxRetries + 1);
  const deadline = Date.now() + attempts * (maxDurationMs + SETTLE_MARGIN_MS);
  while (Date.now() < deadline) {
    const chain = runService.getChain(taskId, ownerId, isAdmin);
    if (!chain) return;
    const latest = chain[chain.length - 1]!;
    // `final` is the precise predicate (section 6.4): terminal AND childless AND no retry intended
    // AND no other attempt still live. An earlier version also returned on `isTerminal(latest)`,
    // which ended the wait during a retry BACKOFF and reported the failed attempt as the task --
    // exactly the terminal-or-interrupted contract section 6.6 exists to keep, since the task is
    // the chain and another attempt is coming.
    if (chainState(chain).final || latest.status === 'NEEDS_INPUT') return;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}
