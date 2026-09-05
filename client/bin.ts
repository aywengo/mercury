#!/usr/bin/env node
// The only place that terminates the process. run() returns an exit code instead of calling
// process.exit so the entire CLI surface stays testable in-process.

import { run } from './cli.ts';

// A closed stdout (mercuryctl runs list | head) must not print a stack trace or change the exit
// code: EPIPE here is normal, expected, and the operator's intent.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const code = await run(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  isTty: process.stdout.isTTY === true,
});
process.exit(code);
