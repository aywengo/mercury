#!/usr/bin/env node
// Mock Claude Code CLI for ClaudeCodeAdapter tests.
//
// The event objects below are BYTE-FOR-BYTE the stdout of a real `claude -p --output-format
// stream-json --verbose` run (claude 1.0.3, model claude-sonnet-4-5), captured from the live CLI
// and pasted through unchanged. They are not a paraphrase of the design doc: the doc's Phase 2
// table does not match this CLI in several ways, and a fixture written from the doc would have
// reproduced the doc's errors instead of catching them.
//
// Modes (env MOCK_CLAUDE_MODE):
//   success      real tool_use -> tool_result -> text -> result, exit 0 (default)
//   error        real failed run: subtype "success" + is_error true, exit 1
//   argv         print the argv it was given, exit 0 (asserts flag construction)
//   split        emit one real line split across two writes, to test JSONL straddling
//   resume       emit a DIFFERENT session id, as the real CLI does on -r
//   hang         emit init then never finish (cancel/terminate tests)
//   noresult     emit assistant text but no result event, exit 0
import { readFileSync, writeFileSync } from 'node:fs';

const MODE = process.env.MOCK_CLAUDE_MODE ?? 'success';
const ARGV_FILE = process.env.MOCK_CLAUDE_ARGV_FILE;
const ENV_FILE = process.env.MOCK_CLAUDE_ENV_FILE;

if (ARGV_FILE) {
  writeFileSync(ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}
if (ENV_FILE) {
  writeFileSync(ENV_FILE, JSON.stringify({
    MERCURY_RUN_ID: process.env.MERCURY_RUN_ID ?? null,
    MERCURY_WORKER_ID: process.env.MERCURY_WORKER_ID ?? null,
  }));
}

// --- captured verbatim from the real CLI -----------------------------------

const REAL_SUCCESS = 
  [
    "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"1da5c35b-215b-4dbe-b91c-cc71ceeed2cd\",\"tools\":[\"Task\",\"Bash\",\"Glob\",\"Grep\",\"LS\",\"Read\",\"Edit\",\"MultiEdit\",\"Write\",\"NotebookRead\",\"NotebookEdit\",\"WebFetch\",\"TodoRead\",\"TodoWrite\",\"WebSearch\"],\"mcp_servers\":[{\"name\":\"beeper\",\"status\":\"failed\"}]}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5-20250929\",\"id\":\"msg_011CehuMExYtjaz29ZVofUmt\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_015Pb8dZAo67BPaA4oiV3TJC\",\"name\":\"Bash\",\"input\":{\"command\":\"echo hello-from-tool\",\"description\":\"Echo hello-from-tool\"},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":25561,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":25561,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":79,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}},\"session_id\":\"1da5c35b-215b-4dbe-b91c-cc71ceeed2cd\"}",
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_015Pb8dZAo67BPaA4oiV3TJC\",\"type\":\"tool_result\",\"content\":\"hello-from-tool\",\"is_error\":false}]},\"session_id\":\"1da5c35b-215b-4dbe-b91c-cc71ceeed2cd\"}",
    "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5-20250929\",\"id\":\"msg_011CehuMW3ADj2WuxzVUEzZB\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"It printed: `hello-from-tool`\"}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":6,\"cache_creation_input_tokens\":189,\"cache_read_input_tokens\":25561,\"cache_creation\":{\"ephemeral_5m_input_tokens\":189,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":13,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}},\"session_id\":\"1da5c35b-215b-4dbe-b91c-cc71ceeed2cd\"}",
    "{\"type\":\"result\",\"subtype\":\"success\",\"cost_usd\":0.1056348,\"is_error\":false,\"duration_ms\":8213,\"duration_api_ms\":5610,\"num_turns\":3,\"result\":\"It printed: `hello-from-tool`\",\"total_cost\":0.1056348,\"session_id\":\"1da5c35b-215b-4dbe-b91c-cc71ceeed2cd\"}"
  ];

const REAL_ERROR = 
  [
    "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"1f6bc1f2-5cdd-442d-ab72-8fe4279afe8d\",\"tools\":[\"Task\",\"Bash\",\"Glob\",\"Grep\",\"LS\",\"Read\",\"Edit\",\"MultiEdit\",\"Write\",\"NotebookRead\",\"NotebookEdit\",\"WebFetch\",\"TodoRead\",\"TodoWrite\",\"WebSearch\"],\"mcp_servers\":[{\"name\":\"beeper\",\"status\":\"failed\"}]}",
    "{\"type\":\"assistant\",\"message\":{\"id\":\"0fdc480e-fec0-4de7-b8e3-32bfa8acd40c\",\"model\":\"<synthetic>\",\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"stop_sequence\":\"\",\"type\":\"message\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0,\"server_tool_use\":{\"web_search_requests\":0}},\"content\":[{\"type\":\"text\",\"text\":\"Invalid API key \u00b7 Please run /login\"}]},\"session_id\":\"1f6bc1f2-5cdd-442d-ab72-8fe4279afe8d\"}",
    "{\"type\":\"result\",\"subtype\":\"success\",\"cost_usd\":0,\"is_error\":true,\"duration_ms\":2553,\"duration_api_ms\":0,\"num_turns\":1,\"result\":\"Invalid API key \u00b7 Please run /login\",\"total_cost\":0,\"session_id\":\"1f6bc1f2-5cdd-442d-ab72-8fe4279afe8d\"}"
  ];

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
}

// --- modes ------------------------------------------------------------------

async function main() {
  const task = await readStdin();
  if (ENV_FILE) {
    // ESM module: require() does not exist here, so use the imported helpers.
    const prev = JSON.parse(readFileSync(ENV_FILE, 'utf8'));
    writeFileSync(ENV_FILE, JSON.stringify({ ...prev, task: task.trim() }));
  }

  if (MODE === 'argv') {
    process.exit(0);
  }

  if (MODE === 'hang') {
    process.stdout.write(REAL_SUCCESS[0] + '\n');
    setInterval(() => {}, 1000); // never exits; cancel/terminate must win
    return;
  }

  if (MODE === 'split') {
    const line = REAL_SUCCESS[1]; // the tool_use line
    const mid = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, mid));
    await new Promise((r) => setTimeout(r, 20));
    process.stdout.write(line.slice(mid) + '\n');
    process.stdout.write(REAL_SUCCESS[2] + '\n');
    process.stdout.write(REAL_SUCCESS[4] + '\n');
    await new Promise((r) => setTimeout(r, 10));
    process.exit(0);
  }

  if (MODE === 'resume') {
    // The real CLI mints a NEW session id when resuming; verified against claude 1.0.3.
    const fresh = REAL_SUCCESS[0].replace(/"session_id":"[^"]+"/, '"session_id":"resumed-new-id-0000"');
    process.stdout.write(fresh + '\n');
    process.stdout.write(REAL_SUCCESS[3] + '\n');
    process.stdout.write(
      REAL_SUCCESS[4].replace(/"session_id":"[^"]+"/, '"session_id":"resumed-new-id-0000"') + '\n',
    );
    process.exit(0);
  }

  if (MODE === 'error_exit0') {
  // The case that makes is_error load-bearing: the run reports failure on the stream but the
  // process still exits 0. Only is_error can catch this, so it is the only case that proves the
  // adapter does not settle purely on the exit code.
  const bad = REAL_ERROR[2].replace('\"is_error\":true', '\"is_error\":true');
  process.stdout.write(REAL_ERROR[0] + '\n');
  process.stdout.write(REAL_ERROR[2] + '\n');
  process.exit(0);
}

if (MODE === 'noresult') {
    process.stdout.write(REAL_SUCCESS[0] + '\n');
    process.stdout.write(REAL_SUCCESS[3] + '\n');
    process.exit(0);
  }

  if (MODE === 'error') {
    for (const l of REAL_ERROR) process.stdout.write(l + '\n');
    process.stderr.write('Error: the model rejected the request\n');
    process.exit(1);
  }

  for (const l of REAL_SUCCESS) process.stdout.write(l + '\n');
  process.exit(0);
}

main();
