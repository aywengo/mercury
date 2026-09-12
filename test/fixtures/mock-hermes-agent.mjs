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
//   MOCK_HERMES_SKILLS     comma-separated names in the simulated installed-skill store
//                          (default: a few Hermes-namespaced names)
//
// Reads the task from stdin (--query-file -). In resume mode, prints the
// resumed session id.
//
// ## `-s` is rejected for unknown names, and that is the whole point of this fixture
//
// The real Hermes resolves `-s <name>` in its OWN installed-skill store and exits non-zero on a name
// it does not have, in under a second, before emitting any response. This fixture reproduces that.
//
// It used to ignore `-s` entirely. That made the central fact of issue #507 untestable: HermesAgentAdapter
// used to emit `-s <mercury-skill-id>`, every such Run died in production, and the mock accepted every
// one so the suite stayed green. A mock that accepts what production rejects does not just fail to
// catch a bug -- it actively certifies the bug. If you are tempted to delete this validation to make a
// test pass, the test is telling you it is about to reintroduce #507.
//
// The default store deliberately contains NO Mercury skill id. Mercury's fallback set is
// planning/implementation/testing/git-pr; none of those is here, which is the exact collision #507 was
// about (docs/crew/teams.md: Hermes has 81 installed skills, none named `planning`).

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.MOCK_HERMES_MODE ?? 'happy';
const argv = process.argv.slice(2);

// Validate `-s` before reading stdin, because the real CLI fails before it does any work. Doing it
// here also means a rejected Run cannot emit a response and then fail -- a half-succeeded Run is the
// worst possible outcome to model, because the adapter would report output AND a non-zero exit.
const installed = new Set((process.env.MOCK_HERMES_SKILLS ?? 'code-review,web-research,note-taking')
  .split(',').map((x) => x.trim()).filter(Boolean));
const requested = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-s') requested.push(argv[i + 1]);
}
const unknown = requested.filter((n) => n === undefined || !installed.has(n));
if (unknown.length > 0) {
  process.stderr.write(`error: unknown skill '${unknown.join("', '")}'\n`);
  process.stderr.write(`installed skills: ${[...installed].join(', ')}\n`);
  process.exitCode = 1;
  // Exit now rather than falling through to the stdin handler: real Hermes is gone in well under a
  // second, and a bounded adapter timeout must not be what makes this test finish.
  process.exit(1);
}

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
