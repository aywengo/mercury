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
import { UsageError } from './api/errors.ts';

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

export function parseArgs(argv: string[]): ParsedInvocation {
  const globals: GlobalOptions = { json: false, noColor: false, help: false, yes: false };
  const path: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  // Global options may appear before the command path. Once a non-flag token is seen, everything
  // after it belongs to the command, so `runs create --json` and `--json runs create` both work,
  // but a command flag is never mistaken for a global one.
  while (i < argv.length) {
    const tok = argv[i]!;
    if (!tok.startsWith('-')) {
      path.push(tok);
      i += 1;
      continue;
    }
    // Match on the flag NAME, before any `=`. Without this split, `--token=abc` falls through to the
    // generic unknown-option branch, which quoted the whole token back into stderr -- putting the
    // credential in terminal scrollback and CI logs, which is the exact thing §13 forbids.
    const flagName = tok.split('=')[0]!;
    if (FORBIDDEN_FLAGS.includes(flagName)) {
      throw new UsageError(
        `${flagName} is not supported: credentials in argv are visible to other local processes and are ` +
          'kept in shell history. Use MERCURY_CLIENT_TOKEN or a named credential in the credentials file.',
      );
    }
    const valueKey = GLOBAL_VALUE_FLAGS[tok];
    if (valueKey) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`${tok} requires a value`);
      }
      (globals as unknown as Record<string, unknown>)[valueKey] =
        valueKey === 'timeoutMs' ? parseTimeoutFlag(tok, value) : value;
      i += 2;
      continue;
    }
    const boolKey = GLOBAL_BOOL_FLAGS[tok];
    if (boolKey) {
      (globals as unknown as Record<string, unknown>)[boolKey] = true;
      i += 1;
      continue;
    }
    // Report the flag NAME only. An unknown option may itself be a credential in disguise
    // (`--password=hunter2`), and the value after `=` must never reach stderr. This is a
    // belt-and-braces rule: it holds even for flags this parser has never heard of.
    throw new UsageError(
      `unknown option ${JSON.stringify(flagName)}` + (tok.length > flagName.length ? ' (value omitted)' : ''),
    );
  }

  // Everything after the command path is the command's own: positionals then flags.
  const positional: string[] = [];
  let j = i;
  while (j < argv.length) {
    const tok = argv[j]!;
    if (tok.startsWith('-') && tok !== '-') {
      // Command flags are stored raw; validating a command's own grammar is that command's job, so
      // `runs create --task` never requires the top-level parser to know about tasks.
      const next = argv[j + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[tok] = next;
        j += 2;
      } else {
        flags[tok] = true;
        j += 1;
      }
      continue;
    }
    positional.push(tok);
    j += 1;
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
const HELP_LINES: string[] = [
  `${PROGRAM} - remote operator client for Mercury Runs`,
  '',
  'USAGE',
  `  ${PROGRAM} [global options] <command> [<args>]`,
  '',
  'COMMANDS',
  '  agents list                list registered agents and the server default',
  '  runs list                  list Runs (newest first)',
  '  runs show <run-id>         show one Run and its recorded skills',
  '  runs create                create a Run from --file or --task/--repo',
  '  runs events <run-id>       print persisted event history',
  '  runs watch <run-id>        follow a Run to a terminal status',
  '  runs input <run-id>        answer a Run waiting for input',
  '  runs cancel <run-id>       request cancellation',
  '  runs retry <run-id>        create a new Run from a terminal one',
  '  config profiles            list configured profiles',
  '  config current             show the resolved profile',
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

/**
 * Commands wired up so far. Kept as data so the help text, the dispatch table and the "not yet
 * available" message cannot disagree about what this build does.
 */
export const IMPLEMENTED = new Set<string>([]);

export interface Stdio {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Run one invocation and return the process exit code.
 *
 * Returns a code rather than calling process.exit so the whole surface is testable in-process; the
 * bin wrapper is the only place that terminates.
 *
 * Milestone 0 ships parsing, help and the credential-flag refusal only. Commands that are parsed but
 * not yet implemented exit 2 with an explicit reason: they are a local condition with no request
 * sent, which is exactly what exit 2 means. Reporting them as a transport failure (7) would imply a
 * server was involved, and reporting success (0) would be a lie that automation would trust.
 */
export function run(argv: string[], io: Stdio): number {
  let parsed: ParsedInvocation;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.stderr(`${PROGRAM}: ${(err as Error).message}\n`);
    return EXIT.USAGE;
  }

  if (parsed.globals.help || parsed.path.length === 0) {
    io.stdout(helpText() + '\n');
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
  // Dispatch for implemented commands is added by the milestone that adds them.
  io.stderr(`${PROGRAM}: ${JSON.stringify(command)} has no handler wired.\n`);
  return EXIT.USAGE;
}
