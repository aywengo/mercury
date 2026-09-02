#!/usr/bin/env node
// Generic mock local CLI agent for LocalAgentAdapter tests.
// Driven entirely by env vars (mirrors mock-prime-agent-rpc.mjs):
//
//   MOCK_LOCAL_MODE      happy | input | input-flag | fail | hang | json | text | resume | leak
//   MOCK_LOCAL_ARGV_FILE write process.argv.slice(2) as JSON
//   MOCK_LOCAL_ENV_FILE  write MERCURY_* env vars as JSON
//   MOCK_LOCAL_SESSION_FILE write the session id as plain text
//
// Modes:
//   happy       jsonl: started, message, tool_started, tool_completed, done(session_id)
//   input       jsonl: started, ask -> wait for one stdin line -> message, done
//   input-flag  jsonl: started, ask -> exit 0 (answer arrives via respawn --answer <v>)
//   fail        jsonl: started, then exit 1
//   hang        jsonl: started, never exits
//   json        single JSON doc at exit: {"result":"ok","messages":["hi"]}
//   text        plain text lines, exit 0
//   resume      reads --resume <id>, emits started + done with that session_id

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.MOCK_LOCAL_MODE ?? 'happy';
const argv = process.argv.slice(2);

if (process.env.MOCK_LOCAL_ARGV_FILE) {
  writeFileSync(process.env.MOCK_LOCAL_ARGV_FILE, JSON.stringify(argv, null, 2));
}
if (process.env.MOCK_LOCAL_ENV_FILE) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('MERCURY_')) env[k] = v;
  }
  writeFileSync(process.env.MOCK_LOCAL_ENV_FILE, JSON.stringify(env, null, 2));
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const sessionId = (() => {
  const i = argv.indexOf('--resume');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return 'sess-' + Math.random().toString(36).slice(2, 10);
})();

if (process.env.MOCK_LOCAL_SESSION_FILE) {
  writeFileSync(process.env.MOCK_LOCAL_SESSION_FILE, sessionId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  switch (mode) {
    case 'happy':
      emit({ type: 'started', run: argv[0] ?? null });
      emit({ type: 'message', text: 'hello from mock' });
      emit({ type: 'toolStarted', tool: 'bash' });
      emit({ type: 'toolCompleted', tool: 'bash' });
      emit({ type: 'done', session_id: sessionId });
      break;

    case 'input': {
      emit({ type: 'started' });
      emit({ type: 'ask', question: 'Continue?', options: ['yes', 'no'] });
      const rl = createInterface({ input: process.stdin });
      const answer = await new Promise((resolve) => rl.once('line', resolve));
      rl.close();
      emit({ type: 'message', text: 'got: ' + answer });
      emit({ type: 'done', session_id: sessionId });
      break;
    }

    case 'input-flag': {
      emit({ type: 'started' });
      const i = argv.indexOf('--answer');
      if (i !== -1 && argv[i + 1]) {
        // answer arrived via respawn flag -> complete
        emit({ type: 'message', text: 'got: ' + argv[i + 1] });
        emit({ type: 'done', session_id: sessionId });
      } else {
        emit({ type: 'ask', question: 'Answer via flag' });
        // exit 0; the adapter respawns with --answer <value>
      }
      break;
    }

    case 'fail':
      emit({ type: 'started' });
      process.exitCode = 1;
      break;

    case 'leak': {
      // Write a trailing line with NO newline, then exit while a grandchild keeps stdout open.
      // stdout therefore never reaches 'end', so only the adapter's bounded drain grace can settle the
      // run -- and the unterminated line can only be delivered by the grace-path flush.
      // Deliberately not process.exit(): that discards pending pipe writes.
      process.stdout.write(JSON.stringify({ type: 'message', text: 'leaked tail' }));
      {
        const holdMs = Number(process.env.MOCK_LOCAL_LEAK_MS ?? '4000');
        const { spawn } = await import('node:child_process');
        const kid = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${holdMs});`], {
          stdio: 'inherit',
          detached: false,
        });
        kid.unref();
      }
      break;
    }

    case 'hang':
      emit({ type: 'started' });
      await new Promise(() => setInterval(() => {}, 1000)); // keep event loop alive
      break;

    case 'json':
      emit({ message: 'hi from json', result: 'ok' });
      break;

    case 'text':
      process.stdout.write('line one\n');
      process.stdout.write('line two\n');
      break;

    case 'resume': {
      emit({ type: 'started', resumed: argv[0] ?? null });
      emit({ type: 'message', text: 'resumed session ' + sessionId });
      emit({ type: 'done', session_id: sessionId });
      break;
    }

    default:
      process.stderr.write('unknown MOCK_LOCAL_MODE: ' + mode + '\n');
      process.exitCode = 2;
  }
  await sleep(10); // let stdout flush
}

main();
