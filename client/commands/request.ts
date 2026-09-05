// Build a create/input request from flags, a file, or stdin (§6.2).
//
// Two rules from the design drive this module, and both are about refusing rather than doing:
//
// 1. Mixing --file with request flags is REJECTED. A merge would have to pick a precedence rule for
//    every field, and whichever rule was chosen would surprise someone. "The file wins" is only
//    surprising to the person who typed --task as well.
// 2. Reading stdin must never block. `--file -` with an interactive terminal attached would hang the
//    command with no prompt and no explanation, which is the same failure mode as a confirmation
//    prompt on a piped stdin. Refusing with a message is always better than waiting.

import { readFileSync } from 'node:fs';
import { UsageError } from '../api/errors.ts';
import { validateCreateRunRequest } from '../api/protocol.ts';
import type { CreateRunRequest } from '../api/protocol.ts';

export interface CreateFlags {
  file?: string;
  task?: string;
  repo?: string;
  agent?: string;
  skills?: string;
}

/** Flags that describe request content, and therefore cannot accompany --file. */
const REQUEST_FLAGS = ['--task', '--repo', '--agent', '--skills'] as const;

export interface ReadContext {
  stdinIsTty: boolean;
  /** Read all of stdin. Only called when stdinIsTty is false. */
  readStdin: () => string;
}

/**
 * Assemble a CreateRunRequest, validating it before it is sent.
 *
 * Validation happens here rather than relying on the server because POST /api/runs accepts almost any
 * body: a `repository` given as a URL string is stored verbatim and yields a Run with nothing to check
 * out, and a misspelled field is ignored outright. Both return 201.
 */
export function buildCreateRequest(flags: CreateFlags, read: ReadContext): CreateRunRequest {
  const supplied = REQUEST_FLAGS.filter((name) => {
    const key = name.slice(2) as keyof CreateFlags;
    return flags[key] !== undefined;
  });

  if (flags.file !== undefined && supplied.length > 0) {
    throw new UsageError(
      `--file cannot be combined with ${supplied.join(', ')}. The file is the request; ` +
        'there is no merge rule, so pick one source.',
    );
  }

  if (flags.file !== undefined) {
    const text = flags.file === '-' ? readStdinNeverBlocks(read, '--file -') : readTextFile(flags.file);
    if (text.trim() === '') throw new UsageError(`${flags.file === '-' ? 'stdin' : flags.file} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`${flags.file === '-' ? 'stdin' : flags.file} is not valid JSON: ${(err as Error).message}`);
    }
    return validateCreateRunRequest(parsed);
  }

  if (flags.task === undefined) {
    throw new UsageError(
      'runs create needs a request. Use --file <path>, --file -, or --task "..." --repo <url>.',
    );
  }

  const request: CreateRunRequest = { task: flags.task };
  if (flags.repo !== undefined) request.repository = { url: flags.repo };
  if (flags.agent !== undefined) request.agent = flags.agent;
  if (flags.skills !== undefined) {
    request.skills = flags.skills.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (request.skills.length === 0) throw new UsageError('--skills got no names; expected a comma-separated list');
  }
  return validateCreateRunRequest(request);
}

/**
 * Parse the body for `runs input`.
 *
 * The server does `req.body?.input ?? req.body`, so a bare JSON value is used directly as the input.
 * The client sends the wrapped form deliberately: it is the one shape that can represent a top-level
 * string, number or null unambiguously, and it does not depend on a fallback that exists for
 * compatibility.
 */
export function buildInputValue(flags: { file?: string; value?: string }, read: ReadContext): unknown {
  if (flags.file !== undefined && flags.value !== undefined) {
    throw new UsageError('--file and --value cannot be combined; pick one source for the input.');
  }
  if (flags.value !== undefined) return flags.value;
  if (flags.file === undefined) {
    // No flag at all: read stdin only when something is actually piped in.
    const text = readStdinNeverBlocks(read, 'runs input');
    return coerceInputText(text);
  }
  const text = flags.file === '-' ? readStdinNeverBlocks(read, '--file -') : readTextFile(flags.file);
  return coerceInputText(text);
}

/**
 * JSON if it parses, otherwise the literal text.
 *
 * An operator piping a sentence should not have to quote it as JSON, but an operator piping a JSON
 * object must get an object rather than a string containing one. Trying JSON first is the only order
 * that satisfies both; the risk is a bare word like `yes` becoming the string "yes" rather than a
 * boolean, which is what the operator typed anyway.
 */
function coerceInputText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') throw new UsageError('input value is empty');
  try {
    return JSON.parse(trimmed);
  } catch {
    return text.replace(/\n$/, '');
  }
}

function readStdinNeverBlocks(read: ReadContext, what: string): string {
  if (read.stdinIsTty) {
    throw new UsageError(
      `${what} was given but stdin is an interactive terminal, so there is nothing to read. ` +
        'Pipe the data in, or pass a file path.',
    );
  }
  return read.readStdin();
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${(err as Error).message}`);
  }
}
