#!/usr/bin/env node
// mercuryctl entry point (docs/cli-tui-design.md §6, §10).
//
// A hand-written parser, deliberately: the design defers any command-framework dependency until
// after Milestone 1 has evidence that one is warranted (§19), and the grammar is shallow enough
// that a dependency would be more surface to learn than the thing it parses.
//
// Help and usage errors must work with NO network access (§16 M0). A user on a plane and a CI job
// with no route to the server both need --help and a correct exit 2 to behave identically.

import { EXIT } from './exitCodes.ts';
import { MercuryClientError, UsageError } from './api/errors.ts';
import { ProtocolError, RUN_STATUSES } from './api/protocol.ts';
import type { RunStatus } from './api/protocol.ts';
import { redactAuthorization } from './credentials.ts';
import { buildContext } from './commands/context.ts';
import { renderAgents } from './commands/agents.ts';
import { renderRunList } from './commands/list.ts';
import { renderRunDetail } from './commands/show.ts';
import { renderInputAck, renderRetry, renderRunAction } from './commands/control.ts';
import { buildCreateRequest, buildInputValue } from './commands/request.ts';
import { createKeyDiagnostic, createRunIdempotent, CreateUncertainError, renderCreate } from './commands/create.ts';
import { confirm, DeclinedError } from './confirm.ts';
import type { MercuryEvent } from './api/protocol.ts';
import { renderEventLine, renderWatchSummary, watchExitCode } from './commands/events.ts';
import { AbortedError, observeRun } from './observe/runObserver.ts';
import { reduceRun } from './observe/reducer.ts';

export const PROGRAM = 'mercuryctl';

export interface GlobalOptions {
  profile?: string;
  url?: string;
  json: boolean;
  noColor: boolean;
  timeoutMs?: number;
  help: boolean;
  yes: boolean;
}

export interface ParsedInvocation {
  globals: GlobalOptions;
  /** e.g. ['runs','list'] -- empty when only globals were given. */
  path: string[];
  /** Positional arguments after the command path. */
  positional: string[];
  /** Command-specific flags, kept raw so each command owns its own grammar. */
  flags: Record<string, string | boolean>;
}

const GLOBAL_VALUE_FLAGS: Record<string, keyof GlobalOptions> = {
  '--profile': 'profile',
  '--url': 'url',
  '--timeout': 'timeoutMs',
};

const GLOBAL_BOOL_FLAGS: Record<string, keyof GlobalOptions> = {
  '--json': 'json',
  '--no-color': 'noColor',
  '--help': 'help',
  '-h': 'help',
  '--yes': 'yes',
};

/**
 * The credential flags that must never exist.
 *
 * argv is readable by any local process through `ps` and is retained in shell history, so a token
 * passed this way lands in two places the operator does not control. The design forbids it (§6,
 * §13), and a generic "unknown option" answer would be a poor reply to someone who will certainly
 * try it -- so it gets its own message saying what to do instead.
 */
export const FORBIDDEN_FLAGS = ['--token', '--api-token', '--bearer'];

/**
 * Whether a token should be read as another flag rather than as a value.
 *
 * A lone `-` is NOT a flag. It is the long-standing convention for "read stdin", and treating it as
 * an option name made `--file -` fail with "--file requires a value" -- the documented stdin form was
 * simply broken. Everything else beginning with `-` is still treated as a flag, so a missing value is
 * still caught instead of swallowing the next option.
 */
function looksLikeFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

export function parseArgs(argv: string[]): ParsedInvocation {
  const globals: GlobalOptions = { json: false, noColor: false, help: false, yes: false };
  const path: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  /**
   * Apply one flag, returning true if this parser consumed it.
   *
   * `commandScope` distinguishes the two halves of the grammar. Before the command name every flag
   * must be a known global, so a typo like `--porfile` is caught. AFTER the command name an
   * unrecognised flag belongs to that command -- `runs create --task` must reach the create command,
   * which owns its own grammar -- so it is stored raw instead of rejected.
   *
   * Forbidden credential flags are refused in BOTH scopes. Checking only the global scope would let
   * `runs list --token=abc` through, which is the one placement an operator is most likely to type.
   */
  const applyFlag = (tok: string, next: string | undefined, commandScope: boolean): { consumed: number } | null => {
    const flagName = tok.split('=')[0]!;
    const inline = tok.includes('=') ? tok.slice(flagName.length + 1) : undefined;

    if (FORBIDDEN_FLAGS.includes(flagName)) {
      throw new UsageError(
        `${flagName} is not supported: credentials in argv are visible to other local processes and are ` +
          'kept in shell history. Use MERCURY_CLIENT_TOKEN or a named credential in the credentials file.',
      );
    }

    const valueKey = GLOBAL_VALUE_FLAGS[flagName];
    if (valueKey) {
      const value = inline ?? next;
      if (value === undefined || (next !== undefined && inline === undefined && looksLikeFlag(value))) {
        throw new UsageError(`${flagName} requires a value`);
      }
      (globals as unknown as Record<string, unknown>)[valueKey] =
        valueKey === 'timeoutMs' ? parseTimeoutFlag(flagName, value) : value;
      return { consumed: inline === undefined ? 2 : 1 };
    }

    const boolKey = GLOBAL_BOOL_FLAGS[flagName];
    if (boolKey) {
      (globals as unknown as Record<string, unknown>)[boolKey] = true;
      return { consumed: 1 };
    }

    if (commandScope) {
      // The command's own flag. Stored raw, with the value attached when one follows, so the command
      // can decide whether it takes a value.
      if (inline !== undefined) {
        flags[flagName] = inline;
        return { consumed: 1 };
      }
      if (next !== undefined && !looksLikeFlag(next)) {
        flags[flagName] = next;
        return { consumed: 2 };
      }
      flags[flagName] = true;
      return { consumed: 1 };
    }

    // Report the flag NAME only. An unknown option may itself be a credential in disguise
    // (`--password=hunter2`), and the value after `=` must never reach stderr.
    throw new UsageError(
      `unknown option ${JSON.stringify(flagName)}` + (tok.length > flagName.length ? ' (value omitted)' : ''),
    );
  };

  let i = 0;
  // Global scope: flags until the first non-flag token, which starts the command.
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!tok.startsWith('-')) break;
    const applied = applyFlag(tok, argv[i + 1], false);
    if (applied) i += applied.consumed;
    else break;
  }

  // Command scope: the command words, then its positionals and flags. Only the first two
  // non-flag tokens form the command path (`runs list`); anything after that is an argument, so
  // `runs show run-123` yields path ['runs','show'] and positional ['run-123'] rather than folding
  // the run id into the command name.
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok.startsWith('-') && tok !== '-') {
      const applied = applyFlag(tok, argv[i + 1], true);
      if (applied) i += applied.consumed;
      continue;
    }
    if (path.length < 2) path.push(tok);
    else positional.push(tok);
    i += 1;
  }

  return { globals, path, positional, flags };
}

function parseTimeoutFlag(flag: string, value: string): number {
  const suffixes: [string, number][] = [['ms', 1], ['s', 1000], ['m', 60_000]];
  for (const [suffix, multiplier] of suffixes) {
    if (value.endsWith(suffix)) {
      const n = Number(value.slice(0, -suffix.length).trim());
      if (Number.isFinite(n) && n > 0) return Math.round(n * multiplier);
      break;
    }
  }
  const bare = Number(value);
  if (Number.isFinite(bare) && bare > 0) return bare;
  throw new UsageError(`${flag} expects a positive duration like 30s, 2m or 1500ms, got ${JSON.stringify(value)}`);
}

export function helpText(): string {
  return HELP_LINES.join('\n');
}

// A flat list so the help text reads as text in review and cannot be broken by nested quoting.
/**
 * Commands wired up so far. Kept as data so the help text, the dispatch table and the "not yet
 * available" message cannot disagree about what this build does.
 */
// Declared before HELP_LINES on purpose: HELP_LINES is a module-level const that calls
// renderCommandHelp(), which reads this Set. Declaring it later is a temporal dead zone error at
// runtime that typecheck does not report, so the ordering is load-bearing rather than stylistic.
export const IMPLEMENTED = new Set<string>([
  'agents list',
  'runs list',
  'runs show',
  'runs create',
  'runs input',
  'runs cancel',
  'runs retry',
  'runs events',
  'runs watch',
]);

/**
 * Every command this CLI knows about, with the summary shown in help.
 *
 * `implemented` is NOT stored here: it is read from IMPLEMENTED at render time, so a milestone that
 * wires up a command updates one set and help follows automatically. Storing it twice is how a
 * command ends up advertised as unavailable after it works.
 */
const COMMAND_SUMMARIES: [string, string][] = [
  ['agents list', 'list registered agents and the server default'],
  ['runs list', 'list Runs (newest first)'],
  ['runs show', 'show one Run and its recorded skills'],
  ['runs create', 'create a Run from --file or --task/--repo'],
  ['runs events', 'print persisted event history'],
  ['runs watch', 'follow a Run to a terminal status'],
  ['runs input', 'answer a Run waiting for input'],
  ['runs cancel', 'request cancellation'],
  ['runs retry', 'create a new Run from a terminal one'],
  ['config profiles', 'list configured profiles'],
  ['config current', 'show the resolved profile'],
];

/** Usage suffix per command, so the argument a caller must supply is visible in help. */
const COMMAND_ARGS: Record<string, string> = {
  'runs show': ' <run-id>',
  'runs events': ' <run-id>',
  'runs watch': ' <run-id>',
  'runs input': ' <run-id>',
  'runs cancel': ' <run-id>',
  'runs retry': ' <run-id>',
};

function renderCommandHelp(): string[] {
  return COMMAND_SUMMARIES.map(([command, summary]) => {
    const label = `${command}${COMMAND_ARGS[command] ?? ''}`;
    const available = IMPLEMENTED.has(command);
    const text = available ? summary : `${summary} [not in this build]`;
    // Unavailable commands are dimmed only when colour is on; the bracketed marker is what carries
    // the meaning, because help is read through pipes and captured in CI logs with no colour.
    return `  ${label.padEnd(29)}${text}`;
  });
}

const HELP_LINES: string[] = [
  `${PROGRAM} - remote operator client for Mercury Runs`,
  '',
  'USAGE',
  `  ${PROGRAM} [global options] <command> [<args>]`,
  '',
  'COMMANDS',
  // Rendered from the same table the dispatcher consults. A hand-maintained list here would drift
  // the moment a milestone landed, and the failure mode is bad in both directions: a command that
  // works but is not listed is invisible, and a command that is listed but does not work sends the
  // operator to a stub.
  ...renderCommandHelp(),
  '',
  'GLOBAL OPTIONS',
  '  --profile <name>           select a profile from the config file',
  '  --url <base-url>           endpoint override (http only for loopback)',
  '  --json                     machine-readable output; never prompts, never colours',
  '  --no-color                 disable ANSI colour',
  '  --timeout <duration>       per-request deadline, e.g. 30s, 2m, 1500ms',
  '  --yes                      skip confirmation prompts',
  '  -h, --help                 show this help',
  '',
  'ENVIRONMENT',
  '  MERCURY_CLIENT_PROFILE     profile to select',
  '  MERCURY_CLIENT_URL         endpoint override',
  '  MERCURY_CLIENT_TOKEN       bearer token (there is no --token flag, by design)',
  '  MERCURY_CLIENT_TIMEOUT_MS  per-request deadline in milliseconds',
  '  MERCURY_CLIENT_NO_COLOR    set to 1/true to disable colour',
  '',
  'EXIT CODES',
  '  0    succeeded / watched Run completed',
  '  2    usage or local configuration error',
  '  3    authentication failed',
  '  4    Run not found or not visible',
  '  5    lifecycle conflict',
  '  6    rate limited',
  '  7    transport, TLS, timeout or server failure',
  '  8    event stream could not recover',
  '  10   watched Run failed',
  '  11   watched Run cancelled',
  '  12   watched Run timed out',
  '  130  interrupted (SIGINT)',
  '',
  'CONFIGURATION',
  '  profiles   $XDG_CONFIG_HOME/mercury/config.json (default ~/.config/mercury)',
  '  tokens     $XDG_CONFIG_HOME/mercury/credentials.json, mode 0600 required',
];

export interface Stdio {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether STDOUT is a terminal; controls colour only. */
  isTty: boolean;
  /** Whether STDIN is a terminal; controls whether a prompt or a stdin read is allowed at all. */
  stdinIsTty: boolean;
  /** Read one line from stdin. Only reached when stdinIsTty is true. */
  readLine: () => Promise<string>;
  /** Read all of stdin. Only reached when stdinIsTty is false. */
  readStdin: () => string;
}

/**
 * Run one invocation and return the process exit code.
 *
 * Returns a code rather than calling process.exit so the whole surface is testable in-process; the
 * bin wrapper is the only place that terminates.
 */
export async function run(argv: string[], io: Stdio): Promise<number> {
  let parsed: ParsedInvocation;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.stderr(`${PROGRAM}: ${(err as Error).message}\n`);
    return EXIT.USAGE;
  }

  if (parsed.globals.help || parsed.path.length === 0) {
    io.stdout(`${helpText()}\n`);
    return EXIT.OK;
  }

  const command = parsed.path.join(' ');
  if (!IMPLEMENTED.has(command)) {
    io.stderr(
      `${PROGRAM}: ${JSON.stringify(command)} is not available in this build yet.\n` +
        `Run \`${PROGRAM} --help\` for what this version does.\n`,
    );
    return EXIT.USAGE;
  }

  try {
    const ctx = buildContext(parsed.globals);
    if (command === 'agents list') {
      io.stdout(`${renderAgents(await ctx.client.listAgents(), ctx, io.isTty)}\n`);
      return EXIT.OK;
    }
    if (command === 'runs list') {
      const status = flagString(parsed.flags, '--status');
      if (status !== undefined && !RUN_STATUSES.includes(status)) {
        throw new UsageError(
          `unknown status ${JSON.stringify(status)}. Valid: ${RUN_STATUSES.join(', ')}`,
        );
      }
      const limit = flagNumber(parsed.flags, '--limit');
      const cursor = flagString(parsed.flags, '--cursor');
      // Narrowed by the guard above rather than asserted away. `as never` type-checked only because it
      // silences the compiler entirely: if RUN_STATUSES and the protocol's RunStatus ever diverged, the
      // cast would keep this compiling while sending a status the server does not recognise -- and the
      // server silently ignores an unknown status, so the operator would get an unfiltered list.
      const statusFilter: RunStatus | undefined = status === undefined ? undefined : (status as RunStatus);
      io.stdout(`${renderRunList(await ctx.client.listRuns({ status: statusFilter, limit, cursor }), ctx, io.isTty)}\n`);
      return EXIT.OK;
    }
    if (command === 'runs show') {
      const runId = requireRunId(parsed, command);
      io.stdout(`${renderRunDetail(await ctx.client.getRun(runId), ctx, io.isTty)}\n`);
      return EXIT.OK;
    }

    if (command === 'runs create') {
      const request = buildCreateRequest(
        {
          file: flagString(parsed.flags, '--file'),
          task: flagString(parsed.flags, '--task'),
          repo: flagString(parsed.flags, '--repo'),
          agent: flagString(parsed.flags, '--agent'),
          skills: flagString(parsed.flags, '--skills'),
        },
        { stdinIsTty: io.stdinIsTty, readStdin: io.readStdin },
      );
      const outcome = await createRunIdempotent(ctx.client, request, {
        idempotencyKey: flagString(parsed.flags, '--idempotency-key'),
        // Prompts and retries are diagnostics, so they belong on stderr: `--json | jq` must still
        // parse when the create needed a retry to succeed.
        onRetry: (info) => io.stderr(
          `${PROGRAM}: create attempt ${info.attempt} failed (${info.reason}); ` +
            `retrying in ${info.waitMs}ms with the same idempotency key\n`,
        ),
      });
      io.stdout(`${renderCreate(outcome, ctx, io.isTty)}\n`);
      if (!ctx.json) io.stderr(`${PROGRAM}: ${createKeyDiagnostic(outcome)}\n`);
      return EXIT.OK;
    }

    if (command === 'runs input') {
      const runId = requireRunId(parsed, command);
      const value = buildInputValue(
        { file: flagString(parsed.flags, '--file'), value: flagString(parsed.flags, '--value') },
        { stdinIsTty: io.stdinIsTty, readStdin: io.readStdin },
      );
      io.stdout(`${renderInputAck(runId, await ctx.client.submitInput(runId, value), ctx, io.isTty)}\n`);
      return EXIT.OK;
    }

    if (command === 'runs cancel' || command === 'runs retry') {
      const runId = requireRunId(parsed, command);
      // Confirmation happens BEFORE the request, so a declined or refused command sends nothing.
      await confirm(
        {
          yes: parsed.globals.yes,
          json: parsed.globals.json,
          stdinIsTty: io.stdinIsTty,
          write: io.stderr,      // prompts are diagnostics, not data
          readLine: io.readLine,
        },
        command,
        runId,
      );
      if (command === 'runs cancel') {
        io.stdout(`${renderRunAction('cancelled', await ctx.client.cancelRun(runId), ctx, io.isTty)}\n`);
      } else {
        io.stdout(`${renderRetry(await ctx.client.retryRun(runId), ctx, io.isTty)}\n`);
      }
      return EXIT.OK;
    }

    if (command === 'runs events' || command === 'runs watch') {
      const runId = requireRunId(parsed, command);
      const follow = command === 'runs watch' || parsed.flags['--follow'] === true;
      const after = flagNumber(parsed.flags, '--after');
      const limit = flagNumber(parsed.flags, '--limit');

      if (command === 'runs events' && !follow) {
        // A single page, and in JSON mode exactly ONE value on stdout -- the same contract every other
        // non-streaming command has. Streaming mode switches to NDJSON, which is why --follow is
        // handled below rather than sharing this branch.
        const page = await ctx.client.listEvents(runId, { after, limit });
        if (ctx.json) { io.stdout(`${JSON.stringify(page)}\n`); return EXIT.OK; }
        if (page.events.length === 0) { io.stdout('no events\n'); return EXIT.OK; }
        for (const event of page.events) io.stdout(`${renderEventLine(event, { ...ctx, isTty: io.isTty })}\n`);
        return EXIT.OK;
      }

      const controller = new AbortController();
      // Ctrl-C aborts the WATCH and leaves the Run untouched (§11.3). The distinction is the whole
      // point: an ordinary terminal interrupt must never become a cancellation request.
      const onSigint = (): void => { controller.abort(); };
      process.on('SIGINT', onSigint);
      try {
        // Retained for the final projection only. The watch prints each event as it arrives and does not
        // need the list to do so; keeping it lets the summary report step, tool and skill counts without
        // the output layer re-scanning anything.
        const seen: MercuryEvent[] = [];
        const outcome = await observeRun({
          client: ctx.client,
          runId,
          signal: controller.signal,
          onEvent: (event) => {
            seen.push(event);
            io.stdout(`${renderEventLine(event, { ...ctx, isTty: io.isTty })}\n`);
          },
          onReconnect: (info) => io.stderr(
            `${PROGRAM}: stream dropped (${info.reason}); reconnecting in ${info.waitMs}ms from sequence ${info.after}\n`,
          ),
        });
        // The reducer needs the Run row, and the watch outcome deliberately carries only a status. One
        // extra read at the end is cheaper than widening the observer's contract, and the status here is
        // the authoritative row rather than an inferred event.
        let presentation = null;
        try {
          const detail = await ctx.client.getRun(runId);
          presentation = reduceRun({ run: detail.run as never, events: seen });
        } catch {
          // A summary read must not turn a successful watch into a failure. The outcome and exit code are
          // already known; the counts are decoration.
        }
        io.stdout(`${renderWatchSummary(outcome, presentation, { ...ctx, isTty: io.isTty })}\n`);
        // `runs events --follow` is a read: it exits 0 whatever the Run did. Only `watch` encodes the
        // outcome, so that `events $id || alert` does not fire on every failed Run.
        return command === 'runs watch' ? watchExitCode(outcome) : EXIT.OK;
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    }

    return EXIT.USAGE;
  } catch (err) {
    return reportError(err, io);
  }
}

/** Every <run-id> command takes exactly one; a second argument is almost always a mistake. */
function requireRunId(parsed: ParsedInvocation, command: string): string {
  const runId = parsed.positional[0];
  if (!runId) throw new UsageError(`${command} needs a run id: ${PROGRAM} ${command} <run-id>`);
  if (parsed.positional.length > 1) {
    throw new UsageError(`${command} takes one run id, got ${parsed.positional.length} arguments`);
  }
  return runId;
}

/**
 * Read a string-valued command flag.
 *
 * A flag given WITHOUT a value is reported rather than silently treated as absent: `--status` with
 * nothing after it currently stores `true`, and quietly listing every Run when the operator asked to
 * filter would be a wrong answer that looks right.
 */
function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  // Covers both `--status` with nothing after it (stored as true) and a repeated flag whose last
  // occurrence was a bare boolean. Either way the operator asked for a filter and did not supply
  // one; listing everything anyway would be a wrong answer that looks right.
  if (typeof value !== 'string') throw new UsageError(`${name} requires a value`);
  return value;
}

function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} expects a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Map a failure to an exit code and a one-line message.
 *
 * Every typed error already carries its code, so this is mostly a passthrough; the interesting part
 * is what it must NOT do. A lifecycle conflict must not be reported as a transport failure, and a
 * server's own message is surfaced verbatim (already credential-free, since the server redacts)
 * rather than replaced with a generic one that would hide why the call failed.
 */
export function reportError(err: unknown, io: Stdio): number {
  if (err instanceof MercuryClientError) {
    io.stderr(`${PROGRAM}: ${redactAuthorization(err.message)}\n`);
    return err.exitCode;
  }
  if (err instanceof AbortedError) {
    // Shell convention: 128 + SIGINT. No message -- the operator pressed Ctrl-C and knows.
    return 130;
  }
  if (err instanceof DeclinedError) {
    // Stated plainly so exit 2 is never read as "you typed the command wrong".
    io.stderr(`${PROGRAM}: ${err.message}\n`);
    return err.exitCode;
  }
  if (err instanceof CreateUncertainError) {
    // The key is the whole point of this path: without it the operator cannot retry safely.
    io.stderr(`${PROGRAM}: ${err.message}\n`);
    return err.exitCode;
  }
  if (err instanceof ProtocolError) {
    io.stderr(`${PROGRAM}: incompatible server response: ${err.message}\n`);
    return EXIT.TRANSPORT;
  }
  io.stderr(`${PROGRAM}: ${redactAuthorization(String((err as Error).message ?? err))}\n`);
  return EXIT.TRANSPORT;
}
