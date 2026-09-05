// Control commands: input, cancel, retry (docs/cli-tui-design.md §6).
//
// Shared shape: each sends one POST and reports what the SERVER said happened. The wording matters
// most for retry -- the server creates a NEW Run, so presenting retry as a transition of the old Run
// would be a lie about the object model, and an operator who believes the old Run restarted will go
// looking for an event stream that stopped forever ago.

import type { OkResponse, RunActionResponse, RetryRunResponse } from '../api/protocol.ts';
import { makeColorizer, sanitizeForTerminal, statusColor } from '../output/human.ts';
import type { CommandContext } from './context.ts';

/** `runs input` returns only { ok: true }, so there is nothing to echo beyond the acknowledgement. */
export function renderInputAck(runId: string, response: OkResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify({ runId, ok: response.ok });
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  // Deliberately does not claim the Run resumed. The server accepted the input; the worker picks it
  // up asynchronously, and `input accepted` is the strongest true statement available here.
  return `${color('green', 'input accepted')} for ${color('cyan', sanitizeForTerminal(runId))}`;
}

export function renderRunAction(
  verb: string,
  response: RunActionResponse,
  ctx: CommandContext,
  isTty: boolean,
): string {
  if (ctx.json) return JSON.stringify(response);
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  return `${color('green', verb)} ${color('cyan', sanitizeForTerminal(response.runId))} ` +
    `is now ${color(statusColor(response.status), response.status)}`;
}

/**
 * `runs retry` returns a NEW run id plus retryOf pointing at the original.
 *
 * Both ids are shown, and the sentence names the new Run as the subject. Saying "run-abc is now
 * QUEUED" after a retry would describe the wrong object: run-abc is still terminal.
 */
export function renderRetry(response: RetryRunResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  const lines = [
    `${color('green', 'created')} ${color('cyan', sanitizeForTerminal(response.runId))} ` +
      `(retry of ${color('cyan', sanitizeForTerminal(response.retryOf ?? 'unknown'))})`,
    `status: ${color(statusColor(response.status), response.status)}`,
    '',
    `follow it with: mercuryctl runs watch ${sanitizeForTerminal(response.runId)}`,
  ];
  return lines.join('\n');
}
