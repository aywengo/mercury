#!/usr/bin/env node
// The only place that terminates the process. run() returns an exit code instead of calling
// process.exit so the entire CLI surface stays testable in-process.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

import { run } from './cli.ts';

// A closed stdout (mercuryctl runs list | head) must not print a stack trace or change the exit
// code: EPIPE here is normal, expected, and the operator's intent.
//
// This exit deliberately does NOT await flushed(), unlike the one at the bottom of this file. EPIPE
// means the reader has already gone, so there is nothing left to deliver the buffer to; flushing a
// closed pipe cannot succeed and would only delay an exit whose data is unreachable. Measured: with
// this handler in place `runs list | head -c 100000` receives exactly 100000 bytes -- well past the
// 64 KiB buffer -- and `| cat` receives all 1,900,049. Nothing the reader asked for is lost here.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// stdin is read in exactly two situations, and both are gated on it being a terminal or not:
// a confirmation prompt (terminal) and `--file -` / piped input (not a terminal). Gating the read on
// isTTY is what guarantees the command can never block waiting for a human who is not there.
const stdinIsTty = process.stdin.isTTY === true;

async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.question('', resolve));
  } finally {
    rl.close();
  }
}

function readStdin(): string {
  // Synchronous so the caller stays a plain function.
  //
  // Imported at module scope, not require()d here: this file is an ES module, where `require` is not
  // defined. The first version did exactly that and wrapped the throw in a catch that returned '', so
  // every piped stdin arrived as empty and the failure looked like a parsing bug rather than a missing
  // import. An empty-string fallback on a read that should never fail silently is the wrong default.
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    throw new Error(`cannot read stdin: ${(err as Error).message}`);
  }
}

/**
 * Exit only after both streams have handed their buffered bytes to the OS.
 *
 * `process.exit()` discards data still queued on a pipe. Writes to a regular file and to a terminal are
 * synchronous, so testing from a checkout cannot see the difference; a pipe is asynchronous, and the
 * buffer is simply dropped. The result was that `mercuryctl runs list | jq` returned the first 64 KiB of
 * a 1.9 MB listing with exit code 0 and no warning -- a silently truncated answer that looks like
 * success to every consumer downstream.
 *
 * Exiting explicitly is still required rather than letting Node settle on its own: the HTTP keep-alive
 * agent holds a socket, so the event loop would otherwise stay alive after the command has finished.
 *
 * `close` and `error` also resolve, because a stream that has already failed -- `| head` closing the pipe
 * mid-write -- will never invoke a write callback, and waiting for one would hang the process instead of
 * truncating it.
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) { resolve(); return; }
    stream.once('close', resolve);
    stream.once('error', () => resolve());
    // A synchronous throw here would leave the promise unresolved with no close and no error to resolve
    // it, so the CLI would hang instead of exiting. Nothing in Node's stream contract promises it cannot
    // happen on a stream in a degraded state, and hanging is strictly worse than truncating: the previous
    // bug lost the tail of a listing, whereas this would never return the shell to the operator.
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

const code = await run(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  isTty: process.stdout.isTTY === true,
  stdinIsTty,
  readLine,
  readStdin,
});

await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
