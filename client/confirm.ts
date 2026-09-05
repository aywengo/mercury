// Confirmation prompts (docs/cli-tui-design.md §6).
//
// The rule in the design is: "Mutating commands ask for confirmation only when stdin is a terminal
// and the operation is destructive or spend-bearing. --yes disables the prompt. Machine-readable mode
// never prompts: it requires --yes where confirmation would otherwise be needed."
//
// The load-bearing part is the FIRST clause, not the --yes clause. A prompt that blocks when stdin is
// a pipe is the classic way a CLI passes every interactive test and then hangs a CI job forever, and a
// hung CI job is much more expensive than a refused command. So the TTY check happens before anything
// reads stdin, and a non-interactive caller that has not passed --yes is refused rather than allowed
// through. Silently performing a destructive action because nobody was attached to answer would be
// the worse failure.

import { EXIT } from './exitCodes.ts';
import { UsageError } from './api/errors.ts';

/**
 * Which operations need confirmation, and why.
 *
 * `cancel` is destructive and `retry` is spend-bearing (it starts a new Run, which costs tokens), so
 * both are confirmed. `create` is NOT confirmed: creating a Run is the command's whole purpose, it is
 * idempotency-keyed so a mistaken invocation is recoverable, and prompting on it would train operators
 * to type `--yes` reflexively -- which is exactly how a confirmation stops protecting anything.
 * `input` is not confirmed either: answering a Run that asked a question is a response, not a decision
 * to spend.
 */
const CONFIRMED_COMMANDS: Record<string, string> = {
  'runs cancel': 'cancel this Run',
  'runs retry': 'retry this Run, which starts a new Run and spends budget',
};

export function requiresConfirmation(command: string): boolean {
  return Object.hasOwn(CONFIRMED_COMMANDS, command);
}

export interface ConfirmContext {
  yes: boolean;
  json: boolean;
  /** Whether stdin is an interactive terminal. Checked before any read. */
  stdinIsTty: boolean;
  write: (text: string) => void;
  /** Read one line from stdin. Only ever called when stdinIsTty is true. */
  readLine: () => Promise<string>;
}

export class DeclinedError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = 'DeclinedError';
  }
}

/**
 * Returns when the operation may proceed; throws otherwise.
 *
 * Exit code choice: a declined confirmation reports USAGE (2). The design's exit table has no
 * "operator declined" code, and inventing one would extend a documented contract that automation
 * branches on. USAGE is defensible because nothing was sent and the process stopped for a local
 * reason -- which is what 2 means -- and any caller that treats non-zero as "it did not happen" gets
 * the correct answer. The message says plainly that the operator declined, so 2 is never mistaken for
 * "you typed the command wrong".
 */
export async function confirm(ctx: ConfirmContext, command: string, subject: string): Promise<void> {
  const action = CONFIRMED_COMMANDS[command];
  if (action === undefined) return;              // not a confirmed operation
  if (ctx.yes) return;                            // operator opted out, in any mode

  if (ctx.json) {
    throw new UsageError(
      `${command} needs --yes in machine-readable mode. JSON mode never prompts, and nothing was sent.`,
    );
  }
  if (!ctx.stdinIsTty) {
    // Deliberately before any read: this is what makes "never blocks on a prompt" true rather than
    // usually true.
    throw new UsageError(
      `${command} needs --yes when stdin is not a terminal. Nothing was sent.`,
    );
  }

  ctx.write(`${command} ${subject}: this will ${action}. Type 'yes' to continue: `);
  const answer = (await ctx.readLine()).trim().toLowerCase();
  if (answer === 'yes' || answer === 'y') return;
  throw new DeclinedError(`${command} declined. Nothing was sent.`);
}
