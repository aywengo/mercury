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
const PROTOCOL_INFO = { name: 'prime-agent.daemon', version: 7 };

/**
 * The wire shape the real supervisor uses: the line type is `session_event`, and the ordering
 * information lives in `meta` rather than at the top level. An earlier version of this fixture
 * invented `{type:"event"}` with top-level sequence/cursor, the adapter agreed with it, and against a
 * live supervisor every single event was classified unrecognised and dropped -- the run completed and
 * Mercury saw nothing.
 */
function sessionEvent(activeSessionId, event, sequence) {
  return {
    type: 'session_event',
    activeSessionId,
    event,
    meta: {
      id: `${activeSessionId}:${sequence}`,
      protocol: { name: 'prime-agent.daemon', version: 7 },
      activeSessionId,
      sequence,
      cursor: { generation: GENERATION, sequence },
      emittedAt: new Date().toISOString(),
    },
  };
}

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

let connectionCount = 0;
const server = net.createServer((socket) => {
  connectionCount += 1;
  const state = { attached: new Set(), buffer: '' };

  if (MODE === 'framed' || (MODE === 'framed_second' && connectionCount > 1)
      || (MODE === 'slow_hello_first' && connectionCount > 1)) {
    // The internal worker transport. A correct client must refuse this loudly, not hang.
    // framed_second frames only the SECOND connection, so a test can prove one bad handshake does not
    // take down an unrelated handshake sharing the same adapter.
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
  if (MODE === 'slow_hello_first' && connectionCount === 1) {
    // Hold the healthy handshake open so a second, broken handshake arrives while it is still pending.
    // Without that overlap the two never interact and a test around it proves nothing.
    setTimeout(() => socket.write(JSON.stringify(hello) + '\n'), 600);
  } else {
    socket.write(JSON.stringify(hello) + '\n');
  }

  const send = (obj) => { socket.write(JSON.stringify(obj) + '\n'); };
  const respondedIds = new Set();
  const respond = (id, command, ok, extra = {}) => {
    // The real supervisor answers a requestId exactly once. A second answer is invisible to the
    // adapter -- its pending entry was resolved by the first -- so the mock would drift from the real
    // protocol while every test stayed green. That is the exact failure mode this fixture exists to
    // prevent, so it is fatal here rather than silent.
    if (respondedIds.has(id)) {
      const msg = `mock bug: duplicate response for requestId ${id} (command ${command})`;
      process.stderr.write(msg + '\n');
      socket.destroy(new Error(msg));
      return;
    }
    respondedIds.add(id);
    send({ id, type: 'response', command, success: ok, ...extra });
  };
  const DIALOG_METHODS = new Set(['select', 'confirm', 'input']);
  const emit = (activeSessionId, event) => {
    const s = sessions.get(activeSessionId);
    if (!s) return;
    for (const client of s.subscribers) {
      if (event.type === 'extension_ui_request' && DIALOG_METHODS.has(event.method)
          && !(client.__caps && client.__caps.has('extension_ui'))) {
        // Mirrors hasExtensionUiClientForMethod: a dialog has no recipient unless the client asked for it.
        continue;
      }
      client.write(JSON.stringify(sessionEvent(activeSessionId, event, ++s.sequence)) + '\n');
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
        || typeof msg.clientId !== 'string' || !msg.clientId
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
        // Remember what this client can actually receive. The supervisor gates dialog delivery on the
        // extension_ui capability; a fixture that ignores it will happily deliver dialogs to a client the
        // real daemon would never send them to.
        state.caps = new Set(Array.isArray(cmd.capabilities) ? cmd.capabilities : []);
        socket.__caps = state.caps;
        s.subscribers.add(socket);
        state.attached.add(cmd.activeSessionId);
        // Echo the negotiated set back, as the real daemon does (daemon-mode.js returns
        // `client: { id, capabilities }` from createAttachResult). Without this the set the adapter
        // advertised is invisible to a test, and an over-claimed capability can only be caught by
        // reading source. Note the real daemon accepts ANY recognised name without checking that the
        // client can honour it -- so this fixture must not validate the set either, or it would be
        // inventing a guard the supervisor does not have.
        //
        // slim_attach is modelled for the same reason: a slim client gets no top-level state/messages
        // duplicate, so a fixture that always sends them would hide a client that reads them.
        const slim = state.caps.has('slim_attach');
        respond(id, 'attach', true, {
          data: {
            activeSessionId: cmd.activeSessionId,
            ...(slim ? {} : { state: { messageCount: 0 }, messages: [] }),
            snapshot: [],
            cursor: { generation: GENERATION, sequence: s.sequence },
            client: { id: cmd.clientId, capabilities: [...state.caps] },
          },
        });
        return;
      }
      case 'prompt': {
        const s = sessions.get(cmd.activeSessionId);
        if (!s) { respond(id, 'prompt', false, { error: 'no such session', errorInfo: { code: 'session_not_found' } }); return; }
        respond(id, 'prompt', true, { data: { accepted: true } });
        if (!s.subscribers.size) return; // the real daemon does not invent a subscriber
        if (process.env.MOCK_DAEMON_PROMPT_REPLIES === '0') return;
        if (process.env.MOCK_DAEMON_CLOSING === '1') {
          // The SUPERVISOR is shutting down -- an infrastructure event, nothing wrong with the agent or
          // the task. It arrives on its own line type, not as a session or command response. The prompt
          // was already answered above; answering twice is a mock bug (see respond).
          setTimeout(() => {
            for (const client of s.subscribers) {
              client.write(JSON.stringify({ type: 'daemon_closing', reason: 'supervisor shutting down' }) + '\n');
            }
          }, 10);
          return;
        }
        if (process.env.MOCK_DAEMON_CLOSE_EARLY === '1') {
          // The session dies mid-run (crash, or killed by another client). The run cannot continue, and
          // without handling this line the adapter waits for its command timeout and reports a timeout.
          const s = sessions.get(cmd.activeSessionId);
          // The prompt was already answered above; a second answer for the same requestId is a mock bug.
          setTimeout(() => {
            for (const client of s.subscribers) {
              client.write(JSON.stringify({ type: 'session_closed', activeSessionId: cmd.activeSessionId,
                reason: 'crashed', meta: { id: `${cmd.activeSessionId}:1`, protocol: PROTOCOL_INFO } }) + '\n');
            }
          }, 10);
          return;
        }
        if (process.env.MOCK_DAEMON_AWAIT_INPUT === '1') {
          // A dialog request: the run now waits for an answer, and the adapter must reply with
          // extension_ui_response rather than another prompt.
          emit(cmd.activeSessionId, { type: 'extension_ui_request', id: 'req-1', method: 'select',
            title: 'Which branch?', message: 'Pick a base branch', options: ['main', 'dev'] });
          return;
        }
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
              client.write(JSON.stringify(sessionEvent(cmd.activeSessionId,
                { delta: 'orphan', noTypeHere: true }, s.sequence)) + '\n');
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
                return JSON.stringify(sessionEvent(cmd.activeSessionId, event, s.sequence));
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
        // The daemon form is {requestId, response}; the flat RPC form {id, value} answers nothing.
        // Enforcing it here is what stops this fixture agreeing with the adapter about a wrong shape,
        // which is the failure mode the previous fixture was built out of.
        if (typeof cmd.requestId !== 'string' || !cmd.requestId || typeof cmd.response !== 'object' || cmd.response === null) {
          respond(id, 'extension_ui_response', false, {
            error: 'extension_ui_response requires requestId and response',
            errorInfo: { code: 'invalid_extension_ui_response' } });
          return;
        }
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
        if (s) {
          // The supervisor announces the closure before the connection goes away.
          for (const c of s.subscribers) {
            c.write(JSON.stringify({ type: 'session_closed', activeSessionId: cmd.activeSessionId,
              reason: 'killed', meta: { id: `${cmd.activeSessionId}:${++s.sequence}`, protocol: PROTOCOL_INFO } }) + '\n');
          }
          respond(id, 'kill', true, { data: { ok: true } });
          for (const c of s.subscribers) c.destroy();
          sessions.delete(cmd.activeSessionId);
          return;
        }
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
