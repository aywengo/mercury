#!/usr/bin/env node
// Mock prime-agent RPC server for tests. Speaks the REAL RPC JSONL protocol
// (prime-agent --mode rpc): commands on stdin, responses + events on stdout.
//
// Modes (MOCK_RPC_MODE):
//   happy  - prompt -> agent_start, text delta, tool exec, agent_end
//   input  - prompt -> extension_ui_request (input dialog), waits for
//            extension_ui_response, then agent_end
//   fail   - prompt -> agent_start, then exit(1) without agent_end
//   hang   - prompt -> agent_start, never agent_end (timeout path)
//   ignore - never responds to any command (send-timeout path)
//   goal   - prompt -> goal_update frames walking active -> paused -> budget_limited ->
//            complete, then agent_end. Proves goal state survives the real RPC protocol
//            instead of falling through the translator's default branch.
// MOCK_RPC_GOAL_UNRECOGNISED: '1' = also emit a status Mercury has never seen, to prove
//            an unrecognised report is surfaced rather than discarded.
//
// MOCK_RPC_SESSION_FILE: path reported by get_state.
// MOCK_RPC_ARGV_FILE:     write the spawned argv (minus node/script) here.
// MOCK_RPC_PID_FILE:      write process.pid here, so a test can tell whether the RPC
//                         process actually died (see issue #46).
// MOCK_RPC_ENV_FILE:      write a subset of the spawned env (MERCURY_*) here.
// MOCK_RPC_VENDOR_EXTRAS: '1' = emit omp-style vendor frames (ready,
//                         negotiate_protocol) at startup to prove they are ignored.

import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.MOCK_RPC_MODE ?? 'happy';
const vendorExtras = process.env.MOCK_RPC_VENDOR_EXTRAS === '1';
const sessionFile = process.env.MOCK_RPC_SESSION_FILE ?? '/tmp/mock-session.jsonl';
const argvFile = process.env.MOCK_RPC_ARGV_FILE;
// Lets a test observe whether the RPC process actually died. Needed to prove the fix for
// issue #46: the adapter resolves the exit promise on `agent_end` while this process is
// still alive reading stdin, so "the run completed" says nothing about the process.
const pidFile = process.env.MOCK_RPC_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
const logFile = process.env.MOCK_RPC_LOG;
function log(msg) {
  if (!logFile) return;
  try { appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

if (argvFile) {
  writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
}

const envFile = process.env.MOCK_RPC_ENV_FILE;
if (envFile) {
  const mercuryEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MERCURY_')));
  writeFileSync(envFile, JSON.stringify(mercuryEnv));
}

let buf = '';
let pendingInput = false;

function send(obj) {
  log('SEND ' + JSON.stringify(obj).slice(0, 200));
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Vendor extras (omp-style protocol v2): a 'ready' frame at startup and a
// 'negotiate_protocol' event. Proves unknown event types are ignored.
if (vendorExtras) {
  send({ type: 'ready', protocolVersion: 2, capabilities: ['subagents', 'host_tools'] });
  send({ type: 'negotiate_protocol', protocolVersion: 2 });
}

function respond(id, command, data, error) {
  const out = { id, type: 'response', command, success: !error };
  if (data !== undefined) out.data = data;
  if (error) out.error = error;
  send(out);
}

function runPromptScript() {
  if (mode === 'fail') {
    send({ type: 'agent_start' });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (mode === 'hang') {
    send({ type: 'agent_start' });
    return; // never agent_end
  }
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  if (mode === 'goal') {
    // Shapes copied from PrimeAgent's own GoalState declaration (dist/core/goals.d.ts), not
    // invented: `active` plus `status`, snake-free camelCase on the wire, and
    // continuationsUsed rather than turnsUsed.
    send({ type: 'goal_update', goal: { active: true, status: 'active', goalId: 'g1', objective: 'make tests pass', tokenBudget: 5000, tokensUsed: 120, timeUsedSeconds: 9, continuationsUsed: 1 } });
    if (process.env.MOCK_RPC_GOAL_UNRECOGNISED === '1') {
      send({ type: 'goal_update', goal: { active: true, status: 'teleported', tokensUsed: 130, timeUsedSeconds: 10, continuationsUsed: 1 } });
    }
    send({ type: 'goal_update', goal: { active: true, status: 'paused', goalId: 'g1', objective: 'make tests pass', tokensUsed: 240, timeUsedSeconds: 20, continuationsUsed: 2, lastReason: 'waiting for a decision' } });
    send({ type: 'goal_update', goal: { active: true, status: 'budget_limited', goalId: 'g1', tokensUsed: 5000, timeUsedSeconds: 31, continuationsUsed: 3, lastReason: 'token budget reached' } });
    send({ type: 'goal_update', goal: { active: true, status: 'complete', goalId: 'g1', tokensUsed: 5200, timeUsedSeconds: 33, continuationsUsed: 3 } });
    send({ type: 'agent_end', messages: [] });
    return;
  }
  if (mode === 'input') {
    send({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'input',
      title: 'Enter a value',
      placeholder: 'type something...',
    });
    pendingInput = true;
    return;
  }
  send({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello from mock agent' },
  });
  send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'echo hi' } });
  send({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'hi' }] },
    isError: false,
  });
  send({ type: 'message_end', message: {} });
  send({ type: 'turn_end', message: {} });
  send({ type: 'agent_end', messages: [] });
}

function handleCommand(cmd) {
  if (mode === 'ignore') return; // never respond (send-timeout path)
  switch (cmd.type) {
    case 'get_state':
      respond(cmd.id, 'get_state', {
        sessionFile,
        sessionId: 'mock-session',
        sessionName: 'mock',
        isStreaming: false,
        isCompacting: false,
        model: null,
        thinkingLevel: 'medium',
        messageCount: 0,
      });
      break;
    case 'prompt':
      respond(cmd.id, 'prompt', undefined);
      runPromptScript();
      break;
    case 'abort':
      respond(cmd.id, 'abort', undefined);
      break;
    case 'switch_session':
      respond(cmd.id, 'switch_session', { cancelled: false });
      break;
    case 'new_session':
      respond(cmd.id, 'new_session', {
        sessionFile: cmd.parentSession ? cmd.parentSession + '.resumed' : '/tmp/mock-new-session.jsonl',
        sessionId: 'mock-session-2',
      });
      break;
    case 'extension_ui_response':
      respond(cmd.id, 'extension_ui_response', undefined);
      break;
    case 'negotiate_protocol':
      respond(cmd.id, 'negotiate_protocol', { protocolVersion: 2 });
      break;
    default:
      respond(cmd.id, cmd.type, {});
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {

  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    log('RECV ' + JSON.stringify(cmd).slice(0, 200));
    if (cmd.type === 'extension_ui_response' && pendingInput) {
      pendingInput = false;
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Got input: ' + JSON.stringify(cmd.value ?? cmd.confirmed ?? cmd.cancelled),
        },
      });
      send({ type: 'message_end', message: {} });
      send({ type: 'turn_end', message: {} });
      send({ type: 'agent_end', messages: [] });
      continue;
    }
    handleCommand(cmd);
  }
});
process.stdin.on('end', () => process.exit(0));
