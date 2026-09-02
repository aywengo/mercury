#!/usr/bin/env node
// Generic mock Hermes Agent CLI for HermesAgentAdapter tests.
// Mimics `hermes chat -Q --query-file -` (verified contract):
//   stdout: ONLY the final response
//   stderr: "session_id: <id>" on exit
//   exit 0 = success, non-zero = failure
//
// Env knobs:
//   MOCK_HERMES_MODE       happy | fail | hang | resume | leak
//   MOCK_HERMES_ARGV_FILE  write process.argv.slice(2) as JSON
//   MOCK_HERMES_ENV_FILE   write MERCURY_* env vars as JSON
//   MOCK_HERMES_SESSION    fixed session id (default random)
//   MOCK_HERMES_RESPONSE   response text (default "Hello from mock hermes")
//
// Reads the task from stdin (--query-file -). In resume mode, prints the
// resumed session id.

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.MOCK_HERMES_MODE ?? 'happy';
const argv = process.argv.slice(2);

if (process.env.MOCK_HERMES_ARGV_FILE) {
  writeFileSync(process.env.MOCK_HERMES_ARGV_FILE, JSON.stringify(argv, null, 2));
}
if (process.env.MOCK_HERMES_ENV_FILE) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('MERCURY_')) env[k] = v;
  }
  writeFileSync(process.env.MOCK_HERMES_ENV_FILE, JSON.stringify(env, null, 2));
}

// read task from stdin (--query-file -)
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (task += c));
process.stdin.on('end', () => {
  const sessionId = process.env.MOCK_HERMES_SESSION ?? 'sess-' + Math.random().toString(36).slice(2, 10);
  const resumed = argv.indexOf('--resume') !== -1 ? argv[argv.indexOf('--resume') + 1] : null;

  switch (mode) {
    case 'happy':
      process.stdout.write((process.env.MOCK_HERMES_RESPONSE ?? 'Hello from mock hermes') + '\n');
      process.stderr.write('\nsession_id: ' + sessionId + '\n');
      break;
    case 'resume':
      process.stdout.write('Resumed session ' + (resumed ?? '?') + '\n');
      process.stderr.write('\nsession_id: ' + sessionId + '\n');
      break;
    case 'fail':
      process.stderr.write('\nsession_id: ' + sessionId + '\n');
      process.exitCode = 1;
      break;
    case 'leak':
      // Exit while a grandchild keeps stdout open, as a real agent that forks a worker can do.
      // stdout never reaches 'end', so the adapter must fall back to its bounded drain grace.
      process.stdout.write('leaked response\n');
      {
        const holdMs = Number(process.env.MOCK_HERMES_LEAK_MS ?? '1500');
        const kid = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${holdMs});`], {
          stdio: 'inherit',
          detached: false,
        });
        kid.unref();
      }
      process.stderr.write('\nsession_id: ' + sessionId + '\n');
      process.exit(0);
      break;
    case 'hang':
      process.stderr.write('\nsession_id: ' + sessionId + '\n');
      setInterval(() => {}, 1000); // keep alive
      break;
    default:
      process.stderr.write('unknown MOCK_HERMES_MODE: ' + mode + '\n');
      process.exitCode = 2;
  }
});
