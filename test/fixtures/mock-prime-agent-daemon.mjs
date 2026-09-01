#!/usr/bin/env node
// Mock prime-agent daemon for tests. Speaks the daemon framing:
//   4-byte big-endian length prefix + JSON payload per frame.
// First frame on connect is a daemon_hello (ignored by the client).
// Then it accepts RPC commands (prompt/abort/get_state) and emits events.
// Modes via MOCK_DAEMON_MODE: happy (default) | input | fail | hang | ignore | pipeline
// Env: MOCK_DAEMON_SOCKET (required), MOCK_DAEMON_LOG (optional debug log path)

import { createServer } from 'node:net';
import { writeFileSync, appendFileSync } from 'node:fs';

const socketPath = process.env.MOCK_DAEMON_SOCKET;
if (!socketPath) {
  console.error('MOCK_DAEMON_SOCKET required');
  process.exit(1);
}
const mode = process.env.MOCK_DAEMON_MODE ?? 'happy';
const method = process.env.MOCK_DAEMON_METHOD ?? 'select';
const logPath = process.env.MOCK_DAEMON_LOG;
const log = (msg) => { if (logPath) appendFileSync(logPath, msg + '\n'); };

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

const HELLO = { kind: 'outbound', outboundType: 'daemon_hello', payloadEncoding: 'jsonl', protocol: { name: 'prime-agent.daemon', version: 7 } };

const server = createServer((socket) => {
  log('client connected');
  if (mode === 'pipeline') {
    // Issue #68: TCP has no frame boundaries, so a daemon may legally coalesce the hello with
    // whatever it sends next into a single write. Emit hello + 4 further frames as ONE write so
    // the test is deterministic rather than relying on Node happening to batch separate writes.
    // A client that reads one frame per `data` event and discards the tail loses all 4 silently.
    socket.write(Buffer.concat([
      frame(HELLO),
      frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'alpha' } }),
      frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'beta' } }),
      frame({ type: 'message_end' }),
      frame({ type: 'agent_end', result: 0 }),
    ]));
    // Half-close so the adapter sees EOF once it has consumed everything. The agent_end above
    // already settled the exit as completed, so the close handler must not overwrite that.
    socket.on('error', () => {});
    socket.end();
    return;
  }
  socket.write(frame(HELLO));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) break;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) break;
      const raw = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      let cmd;
      try { cmd = JSON.parse(raw); } catch { continue; }
      log('cmd: ' + raw);
      handleCommand(socket, cmd);
    }
  });
  socket.on('error', () => {});
});

function handleCommand(socket, cmd) {
  if (cmd.type === 'get_state') {
    socket.write(frame({ type: 'response', id: cmd.id, command: 'get_state', success: true, sessionFile: process.env.MOCK_DAEMON_SESSION_FILE ?? null, sessionId: 'mock-session', model: 'mock-model', messageCount: 1 }));
    return;
  }
  if (cmd.type === 'prompt') {
    socket.write(frame({ type: 'response', id: cmd.id, command: 'prompt', success: true }));
    if (mode === 'ignore') return;
    if (mode === 'fail') {
      socket.write(frame({ type: 'agent_end', result: 1 }));
      socket.end();
      return;
    }
    if (mode === 'input') {
      socket.write(frame({ type: 'extension_ui_request', id: 'req-1', method, title: 'Question', message: 'Continue?', options: [{ label: 'yes', value: 'yes' }, { label: 'no', value: 'no' }] }));
      socket.write(frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'waiting for input' } }));
      return;
    }
    // happy: emit a couple of events then finish
    socket.write(frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello from ' } }));
    socket.write(frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'daemon mock' } }));
    socket.write(frame({ type: 'message_end' }));
    socket.write(frame({ type: 'tool_execution_start', toolName: 'ipython', args: { code: '1+1' } }));
    socket.write(frame({ type: 'tool_execution_end', toolName: 'ipython', result: '2' }));
    socket.write(frame({ type: 'agent_end', result: 0 }));
    socket.end();
    return;
  }
  if (cmd.type === 'abort') {
    socket.write(frame({ type: 'response', id: cmd.id, command: 'abort', success: true }));
    socket.end();
    return;
  }
  if (cmd.type === 'extension_ui_response') {
    log('input response: ' + JSON.stringify(cmd));
    // fire-and-forget: no response frame
    socket.write(frame({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'got input' } }));
    socket.write(frame({ type: 'message_end' }));
    socket.write(frame({ type: 'agent_end', result: 0 }));
    socket.end();
    return;
  }
  socket.write(frame({ type: 'response', id: cmd.id, command: cmd.type, success: false, error: 'unknown command' }));
}

server.listen(socketPath, () => {
  log('mock daemon listening on ' + socketPath);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
