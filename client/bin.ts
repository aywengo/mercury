#!/usr/bin/env node
// The only place that terminates the process. run() returns an exit code instead of calling
// process.exit so the entire CLI surface stays testable in-process.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

import { run } from './cli.ts';

// A closed stdout (mercuryctl runs list | head) must not print a stack trace or change the exit
// code: EPIPE here is normal, expected, and the operator's intent.
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

const code = await run(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  isTty: process.stdout.isTTY === true,
  stdinIsTty,
  readLine,
  readStdin,
});
process.exit(code);
