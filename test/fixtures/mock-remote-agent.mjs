#!/usr/bin/env node
// Generic mock remote agent API server for RemoteAgentAdapter tests.
// Implements the API shape from docs/agent-adapters.md section 5.4 (Devin-style).
//
// Env knobs:
//   MOCK_REMOTE_PORT            port to listen on (default 0 = random; prints "LISTENING <port>")
//   MOCK_REMOTE_MODE            happy | input | fail | hang | api-fail
//   MOCK_REMOTE_LOG             file to append request log (JSONL)
//   MOCK_REMOTE_REQUIRE_AUTH    '1' to require "Authorization: Bearer <token>"
//   MOCK_REMOTE_TOKEN           expected token when REQUIRE_AUTH (default "mock-token")
//   MOCK_REMOTE_SESSION_FILE    file to write created session id
//   MOCK_REMOTE_INPUT_FILE      file to append received input bodies (JSONL)
//   MOCK_REMOTE_CANCEL_FILE     file to append cancelled session ids
//   MOCK_REMOTE_STATUS_FILE     file to append status responses (JSONL)
//
// API shape:
//   POST /sessions              -> 201 { session: { id } }
//   GET  /sessions/:id          -> 200 { status: running|success|error|cancelled }
//   GET  /sessions/:id/events   -> 200 { events: [...] }
//   POST /sessions/:id/messages -> 200 { ok: true } (records body)
//   POST /sessions/:id/cancel   -> 200 { ok: true }
//
// Modes:
//   happy     events: started, message, tool_started, tool_completed; success after 3 polls
//   input     events: started, ask; status stays running until input arrives, then message + success
//   fail      events: started; error after 2 polls
//   hang      events: started; running forever (until cancel)
//   api-fail  first 2 status polls return HTTP 500, then behave like happy

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.env.MOCK_REMOTE_PORT ?? 0);
const mode = process.env.MOCK_REMOTE_MODE ?? 'happy';
const logFile = process.env.MOCK_REMOTE_LOG;
const requireAuth = process.env.MOCK_REMOTE_REQUIRE_AUTH === '1';
const token = process.env.MOCK_REMOTE_TOKEN ?? 'mock-token';

const sessions = new Map();

function log(msg) {
  if (logFile) appendFileSync(logFile, JSON.stringify(msg) + '\n');
}

function makeSession() {
  const id = 'sess-' + Math.random().toString(36).slice(2, 10);
  const s = { id, polls: 0, status: 'running', events: [], inputs: [], cancelled: false };
  if (mode === 'happy' || mode === 'api-fail') {
    s.events = [
      { type: 'started', id: 'e1' },
      { type: 'message', text: 'hello from remote', id: 'e2' },
      { type: 'tool_started', tool: 'bash', id: 'e3' },
      { type: 'tool_completed', tool: 'bash', id: 'e4' },
    ];
  } else if (mode === 'input') {
    s.events = [{ type: 'started', id: 'e1' }, { type: 'ask', question: 'Continue?', id: 'e2' }];
  } else {
    s.events = [{ type: 'started', id: 'e1' }];
  }
  sessions.set(id, s);
  return s;
}

function statusFor(s) {
  if (s.cancelled) return 'cancelled';
  s.polls++;
  if (mode === 'happy' || mode === 'api-fail') return s.polls >= 3 ? 'success' : 'running';
  if (mode === 'input') {
    if (s.inputs.length > 0) return s.polls >= 2 ? 'success' : 'running';
    return 'running';
  }
  if (mode === 'fail') return s.polls >= 2 ? 'error' : 'running';
  return 'running'; // hang
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (requireAuth) {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer ' + token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
    log({ method: req.method, path, body: parsed });

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'POST' && path === '/sessions') {
      const s = makeSession();
      if (process.env.MOCK_REMOTE_SESSION_FILE) writeFileSync(process.env.MOCK_REMOTE_SESSION_FILE, s.id);
      send(201, { session: { id: s.id } });
      return;
    }

    const m = path.match(/^\/sessions\/([^/]+)$/);
    const me = path.match(/^\/sessions\/([^/]+)\/events$/);
    const mm = path.match(/^\/sessions\/([^/]+)\/messages$/);
    const mc = path.match(/^\/sessions\/([^/]+)\/cancel$/);

    if (req.method === 'GET' && m) {
      const s = sessions.get(m[1]);
      if (!s) return send(404, { error: 'not found' });
      if (mode === 'api-fail' && s.polls < 2) {
        s.polls++;
        return send(500, { error: 'boom' });
      }
      const status = statusFor(s);
      if (process.env.MOCK_REMOTE_STATUS_FILE) {
        appendFileSync(process.env.MOCK_REMOTE_STATUS_FILE, JSON.stringify({ id: s.id, status }) + '\n');
      }
      return send(200, { status });
    }

    if (req.method === 'GET' && me) {
      const s = sessions.get(me[1]);
      if (!s) return send(404, { error: 'not found' });
      return send(200, { events: s.events });
    }

    if (req.method === 'POST' && mm) {
      const s = sessions.get(mm[1]);
      if (!s) return send(404, { error: 'not found' });
      s.inputs.push(parsed);
      if (process.env.MOCK_REMOTE_INPUT_FILE) {
        appendFileSync(process.env.MOCK_REMOTE_INPUT_FILE, JSON.stringify(parsed) + '\n');
      }
      if (mode === 'input') {
        s.events.push({ type: 'message', text: 'got: ' + (parsed.message ?? ''), id: 'e3' });
      }
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && mc) {
      const s = sessions.get(mc[1]);
      if (!s) return send(404, { error: 'not found' });
      s.cancelled = true;
      if (process.env.MOCK_REMOTE_CANCEL_FILE) {
        appendFileSync(process.env.MOCK_REMOTE_CANCEL_FILE, s.id + '\n');
      }
      return send(200, { ok: true });
    }

    send(404, { error: 'not found' });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('LISTENING ' + server.address().port);
});
