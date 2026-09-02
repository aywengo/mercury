#!/usr/bin/env node
/**
 * A stand-in for the PrimeAgent daemon SUPERVISOR, for adapter tests.
 *
 * Derived from the real protocol, not from the adapter's expectations:
 *   - the hello is the captured fixture in test/fixtures/daemon-hello.jsonl (a real 0.9.1 supervisor),
 *   - the command envelope is validated with the daemon's own rules (type/id/protocol/clientId/command),
 *   - responses use the two shapes the real supervisor sends, including errorInfo.code,
 *   - events are delivered only to a client that has `attach`ed, with a server-assigned sequence and
 *     a cursor carrying the supervisor generation.
 *
 * The previous fixture spoke 4-byte framing and a bare {type:"prompt"} command, i.e. it agreed with
 * the adapter about every way the adapter was wrong, so all twelve tests passed against a daemon that
 * does not exist. This one disagrees where the real daemon disagrees.
 *
 * Knobs (env):
 *   MOCK_DAEMON_MODE           happy | framed | bad-version | missing-cap | reject-create | silent
 *   MOCK_DAEMON_HELLO          path to a hello fixture to replay verbatim
 *   MOCK_DAEMON_PROMPT_REPLIES "1" to emit a scripted assistant turn after a prompt
 */
import net from 'node:net';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MODE = process.env.MOCK_DAEMON_MODE ?? 'happy';
const HELLO_FILE = process.env.MOCK_DAEMON_HELLO;
const SOCKET_PATH = process.argv[2];
if (!SOCKET_PATH) { console.error('usage: mock-prime-agent-daemon.mjs <socket-path>'); process.exit(2); }

function loadHello() {
  if (HELLO_FILE) {
    const line = readFileSync(HELLO_FILE, 'utf8').split('\n').filter((l) => !l.startsWith('#') && l.trim())[0];
    return JSON.parse(line);
  }
  return {
    type: 'daemon_hello',
    socketPath: SOCKET_PATH,
    protocol: { name: 'prime-agent.daemon', version: 7 },
    schemaId: 'protocol-7-schema-25-585ef1102921',
    schemaRevision: 25,
    appVersion: '0.9.1',
    supervisorGeneration: randomUUID(),
    supervisorOwnerToken: 'mock-fencing-token',
    supervisorPid: process.pid,
    clientId: 'mock00000001',
    serverCapabilities: ['attach_snapshot', 'event_sequence', 'slim_attach', 'chunked_snapshot',
      'client_owned_sessions', 'model_catalog'],
  };
}

const GENERATION = randomUUID();
/** Every raw line the client sent, so tests can assert on what was actually put on the wire. */
const received = [];
const sessions = new Map();

function encodeFramed(obj) {
  // Exactly the daemon's private-framing.js layout: two u32 lengths, header JSON, payload JSON.
  const header = Buffer.from(JSON.stringify({ kind: 'outbound', outboundType: 'daemon_hello', payloadEncoding: 'jsonl' }), 'utf8');
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.allocUnsafe(8 + header.length + payload.length);
  frame.writeUInt32BE(header.length, 0);
  frame.writeUInt32BE(payload.length, 4);
  header.copy(frame, 8);
  payload.copy(frame, 8 + header.length);
  return frame;
}

const server = net.createServer((socket) => {
  const state = { attached: new Set(), buffer: '' };

  if (MODE === 'framed') {
    // The internal worker transport. A correct client must refuse this loudly, not hang.
    socket.write(encodeFramed(loadHello()));
    return;
  }
  const hello = loadHello();
  if (MODE === 'bad-version') hello.protocol = { name: 'prime-agent.daemon', version: 99 };
  if (MODE === 'wrong-name') hello.protocol = { name: 'other.daemon', version: 7 };
  if (MODE === 'missing-cap') {
    hello.serverCapabilities = hello.serverCapabilities.filter((c) => c !== 'event_sequence');
  }
  if (MODE === 'silent') return; // accepts the connection, never greets
  socket.write(JSON.stringify(hello) + '\n');

  const send = (obj) => { socket.write(JSON.stringify(obj) + '\n'); };
  const respond = (id, command, ok, extra = {}) => {
    send({ id, type: 'response', command, success: ok, ...extra });
  };
  const emit = (activeSessionId, event) => {
    const s = sessions.get(activeSessionId);
    if (!s) return;
    for (const client of s.subscribers) {
      client.write(JSON.stringify({
        type: 'event', activeSessionId, sequence: ++s.sequence,
        cursor: { generation: GENERATION, sequence: s.sequence },
        emittedAt: new Date().toISOString(),
        event,
      }) + '\n');
    }
  };

  socket.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let i;
    while ((i = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, i);
      state.buffer = state.buffer.slice(i + 1);
      if (!line.trim()) continue;
      // Recorded so a test can assert on what was actually put on the wire and in what order,
      // rather than on adapter internals that a wrong implementation could still set correctly.
      if (process.env.MOCK_DAEMON_TRANSCRIPT) appendFileSync(process.env.MOCK_DAEMON_TRANSCRIPT, line + '\n');
      handle(line);
    }
  });

  function handle(line) {
    received.push(line);
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Envelope rules, mirroring isDaemonCommandEnvelope. A message that is not an envelope is a client
    // bug; answer it with an explicit refusal so a test fails with a message instead of hanging.
    if (msg.type !== 'command' || typeof msg.id !== 'string'
        || msg.protocol?.name !== 'prime-agent.daemon' || typeof msg.protocol?.version !== 'number'
        || typeof msg.command !== 'object' || msg.command === null) {
      send({ id: typeof msg.id === 'string' ? msg.id : '', type: 'response',
        command: String(msg.type ?? ''), success: false,
        error: 'message is not a daemon command envelope',
        errorInfo: { code: 'invalid_envelope' } });
      return;
    }
    const cmd = msg.command;
    const id = msg.id;

    switch (cmd.type) {
      case 'create': {
        if (MODE === 'reject-create') {
          respond(id, 'create', false, { error: 'no capacity', errorInfo: { code: 'no_capacity' } });
          return;
        }
        const activeSessionId = 'sess_' + Math.random().toString(16).slice(2, 10);
        sessions.set(activeSessionId, { subscribers: new Set(), sequence: 0, config: cmd.config ?? {} });
        respond(id, 'create', true, { data: { activeSessionId, sessionId: randomUUID(), lifecycle: 'draft' } });
        return;
      }
      case 'attach': {
        const s = sessions.get(cmd.activeSessionId);
        if (!s) { respond(id, 'attach', false, { error: 'no such session', errorInfo: { code: 'session_not_found' } }); return; }
        s.subscribers.add(socket);
        state.attached.add(cmd.activeSessionId);
        respond(id, 'attach', true, { data: { snapshot: [], cursor: { generation: GENERATION, sequence: s.sequence } } });
        return;
      }
      case 'prompt': {
        const s = sessions.get(cmd.activeSessionId);
        if (!s) { respond(id, 'prompt', false, { error: 'no such session', errorInfo: { code: 'session_not_found' } }); return; }
        respond(id, 'prompt', true, { data: { accepted: true } });
        if (!s.subscribers.size) return; // the real daemon does not invent a subscriber
        if (process.env.MOCK_DAEMON_PROMPT_REPLIES === '0') return;
        setTimeout(() => {
          const turn = [
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } },
            { type: 'message_end' },
            { type: 'agent_end', result: 0 },
          ];
          if (process.env.MOCK_DAEMON_SHAPELESS === '1') {
            // An event with no `type`: not translatable, and the adapter must say so rather than
            // quietly contribute a hole to the run's history.
            const s = sessions.get(cmd.activeSessionId);
            for (const client of s.subscribers) {
              s.sequence += 1;
              client.write(JSON.stringify({ type: 'event', activeSessionId: cmd.activeSessionId,
                sequence: s.sequence, cursor: { generation: GENERATION, sequence: s.sequence },
                emittedAt: new Date().toISOString(),
                event: { delta: 'orphan', noTypeHere: true } }) + '\n');
            }
            setTimeout(() => { for (const e of turn.slice(2)) emit(cmd.activeSessionId, e); }, 5);
            return;
          }
          if (process.env.MOCK_DAEMON_COALESCE === '1') {
            // One write carrying every frame. TCP gives no record boundaries, and a reader that
            // attaches after the first line loses everything that shared the previous write (#68).
            const s = sessions.get(cmd.activeSessionId);
            for (const client of s.subscribers) {
              const blob = turn.map((event) => {
                s.sequence += 1;
                return JSON.stringify({ type: 'event', activeSessionId: cmd.activeSessionId,
                  sequence: s.sequence, cursor: { generation: GENERATION, sequence: s.sequence },
                  emittedAt: new Date().toISOString(), event });
              }).join('\n') + '\n';
              client.write(blob);
            }
            return;
          }
          for (const event of turn) emit(cmd.activeSessionId, event);
        }, 10);
        return;
      }
      case 'extension_ui_response': {
        respond(id, 'extension_ui_response', true, { data: { ok: true } });
        if (process.env.MOCK_DAEMON_AFTER_INPUT === 'end') {
          emit(cmd.activeSessionId, { type: 'agent_end', result: 0 });
        }
        return;
      }
      case 'detach': {
        const s = sessions.get(cmd.activeSessionId);
        if (s) s.subscribers.delete(socket);
        respond(id, 'detach', true, { data: { ok: true } });
        return;
      }
      case 'abort':
        respond(id, 'abort', true, { data: { ok: true } });
        return;
      case 'kill': {
        const s = sessions.get(cmd.activeSessionId);
        if (s) { for (const c of s.subscribers) c.destroy(); sessions.delete(cmd.activeSessionId); }
        respond(id, 'kill', true, { data: { ok: true } });
        return;
      }
      case 'list':
        respond(id, 'list', true, { data: { sessions: [...sessions.keys()].map((k) => ({ id: k })) } });
        return;
      default:
        respond(id, cmd.type, false, { error: `unknown command ${cmd.type}`, errorInfo: { code: 'unknown_command' } });
    }
  }
});

// A socket file left by a crashed run is not a live listener; bind would fail with EADDRINUSE and the
// failure would look like a port conflict rather than stale state.
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

server.listen(SOCKET_PATH, () => {
  process.stdout.write(JSON.stringify({ ready: true, socketPath: SOCKET_PATH, generation: GENERATION }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));

/** Exposed for in-process tests that want to assert on the wire, not on adapter internals. */
export const __test = { received, sessions };
