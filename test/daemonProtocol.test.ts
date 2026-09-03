import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCommandEnvelope, checkHello, checkSocketPath, helloForLogging, looksPrivateFramed,
  parseDaemonLine, toDaemonUiResponse, DAEMON_PROTOCOL_NAME, MERCURY_DAEMON_PROTOCOL_VERSION,
  MAX_SOCKET_PATH_BYTES, PRIVATE_TRANSPORT_HINT, describeConnectError,
} from '../src/adapters/daemonProtocol.ts';

/**
 * Locate the installed prime-agent package.
 *
 * An earlier draft hard-coded the path from the machine this was written on. That is worse than not
 * checking at all: the guard would skip on every other machine, and a skip that always happens is
 * indistinguishable from a check that always passes.
 */
function findPrimeAgentPackage(): string | null {
  const candidates: string[] = [];
  if (process.env.MERCURY_PRIMEAGENT_PKG) candidates.push(process.env.MERCURY_PRIMEAGENT_PKG);
  // The repo's own knob for pointing at a non-default install.
  const cmd = process.env.MERCURY_PRIMEAGENT_CMD;
  if (cmd && cmd.includes('/')) {
    let dir = dirname(cmd);
    for (let i = 0; i < 6 && dir !== '/'; i++) {
      if (existsSync(join(dir, 'package.json'))) { candidates.push(dir); break; }
      dir = dirname(dir);
    }
  }
  try {
    candidates.push(dirname(dirname(createRequire(import.meta.url).resolve('prime-agent/package.json'))));
  } catch { /* not a dependency of this repo, which is the normal case */ }
  // npm's configured prefix is only one of the places a global install lands; a user-level install
  // under ~/.local is common and is where this machine's copy actually lives.
  for (const probe of ['~/.local/lib/node_modules', '~/.npm-global/lib/node_modules', '/usr/local/lib/node_modules']) {
    candidates.push(join(probe.replace(/^~/, process.env.HOME ?? '~'), 'prime-agent'));
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 15_000 }).trim();
    if (globalRoot) candidates.push(join(globalRoot, 'prime-agent'));
  } catch { /* npm unavailable */ }
  try {
    const bin = execSync('command -v prime-agent || true', { encoding: 'utf8', timeout: 15_000 }).trim();
    if (bin) {
      // The CLI is a symlink into the package; walk up to the directory that owns package.json.
      let dir = dirname(realpathSync(bin));
      for (let i = 0; i < 6 && dir !== '/'; i++) {
        if (existsSync(join(dir, 'package.json'))) { candidates.push(dir); break; }
        dir = dirname(dir);
      }
    }
  } catch { /* not on PATH */ }
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'prime-agent') return dir;
    } catch { /* not a package root */ }
  }
  return null;
}

/**
 * The hello is a capture from a real supervisor, not a hand-written object. A fixture invented from
 * the same assumptions as the parser would agree with it about everything the parser gets wrong --
 * which is precisely how the previous adapter's twelve tests all passed.
 */
const REAL_HELLO = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'daemon-hello.jsonl'), 'utf8')
    .split('\n').filter((l) => !l.startsWith('#') && l.trim())[0],
);

test('the real 0.9.1 hello is accepted and negotiates protocol v7', () => {
  const r = checkHello(REAL_HELLO);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.protocolVersion, 7);
    assert.ok(r.capabilities.includes('event_sequence'));
    assert.equal(r.generation, '00000000-0000-0000-0000-000000000000');
  }
});

test('a NEWER daemon protocol is refused, naming observed and supported', () => {
  // The dangerous direction to get wrong: assuming forward compatibility means every later daemon
  // silently produces a run that never emits an event.
  const r = checkHello({ ...REAL_HELLO, protocol: { name: DAEMON_PROTOCOL_NAME, version: 8 } });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /newer protocol/);
    assert.equal(r.observed, 'v8');
    assert.match(r.expected, /<= v7/);
  }
});

test('an older daemon without the command envelope is refused', () => {
  const r = checkHello({ ...REAL_HELLO, protocol: { name: DAEMON_PROTOCOL_NAME, version: 6 } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.expected, />= v7/);
});

test('a different protocol name is refused rather than guessed at', () => {
  const r = checkHello({ ...REAL_HELLO, protocol: { name: 'something-else.daemon', version: 7 } });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.observed, 'something-else.daemon');
    assert.equal(r.expected, DAEMON_PROTOCOL_NAME);
  }
});

test('a missing required capability is refused and named', () => {
  // Without event_sequence there is no server cursor, so resume after a worker restart would either
  // lose or duplicate events. Better to refuse the run at start than to corrupt its event stream.
  const caps = REAL_HELLO.serverCapabilities.filter((c: string) => c !== 'event_sequence');
  const r = checkHello({ ...REAL_HELLO, serverCapabilities: caps });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /missing capabilities/);
    assert.equal(r.observed, 'event_sequence');
  }
});

test('a hello with no capabilities list is refused, not treated as capability-free', () => {
  const { serverCapabilities: _drop, ...rest } = REAL_HELLO;
  const r = checkHello(rest);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing capabilities/);
});

test('framed bytes from the internal worker transport are recognised', () => {
  // Built exactly the way the daemon's own private-framing.js builds one: two u32 lengths, then the
  // header JSON, then the payload JSON. These are the real first bytes observed on a socket that
  // turned out to be a session worker rather than a supervisor.
  const header = Buffer.from(JSON.stringify({ kind: 'outbound', outboundType: 'daemon_hello', payloadEncoding: 'jsonl' }), 'utf8');
  const payload = Buffer.from(JSON.stringify(REAL_HELLO), 'utf8');
  const frame = Buffer.alloc(8 + header.length + payload.length);
  frame.writeUInt32BE(header.length, 0);
  frame.writeUInt32BE(payload.length, 4);
  header.copy(frame, 8);
  payload.copy(frame, 8 + header.length);

  assert.equal(looksPrivateFramed(frame.subarray(0, 32)), true);
  // The same hello as JSONL -- what a real supervisor sends -- must NOT be flagged, or the check
  // would reject the only transport that works.
  assert.equal(looksPrivateFramed(Buffer.from(JSON.stringify(REAL_HELLO) + '\n', 'utf8')), false);
  assert.match(PRIVATE_TRANSPORT_HINT, /PRIME_AGENT_INTERNAL_DAEMON_WORKER/);
});

test('a socket path over the Unix limit is refused before connect', () => {
  const short = checkSocketPath('/tmp/prime-agent-501/daemon.sock');
  assert.equal(short, null);
  const deep = '/' + 'a/'.repeat(60) + 'prime-agent-501/daemon.sock';
  assert.ok(Buffer.byteLength(deep) > MAX_SOCKET_PATH_BYTES);
  const err = checkSocketPath(deep);
  assert.ok(err);
  assert.match(err!, /EINVAL/);
  assert.match(err!, /MERCURY_DAEMON_SOCKET/);
});

test('the command envelope matches what the daemon itself builds', async (tc) => {
  const mine = buildCommandEnvelope({
    command: { type: 'prompt', activeSessionId: 'sess_1', message: 'hi' },
    id: 'c1', clientId: 'mercury:run:r1', protocolVersion: 7,
  });
  assert.deepEqual(mine, {
    type: 'command', id: 'c1',
    protocol: { name: 'prime-agent.daemon', version: 7 },
    clientId: 'mercury:run:r1',
    command: { type: 'prompt', activeSessionId: 'sess_1', message: 'hi' },
  });

  // Fidelity guard: compare against the shipped implementation when the package is installed, so the
  // two cannot drift apart silently. Skips loudly rather than silently when it is absent.
  const pkgDir = findPrimeAgentPackage();
  if (!pkgDir) {
    // Reported as a skip, not logged from a test that then passes. A guard that returns early prints a
    // check mark, and a check mark that always appears is worth nothing -- that is the exact failure
    // this whole file exists to prevent.
    tc.skip('prime-agent package not found; envelope compared against the recorded shape only. '
      + 'Set MERCURY_PRIMEAGENT_PKG to the installed package directory to enable the comparison.');
    return;
  }
  const real: any = await import(pathToFileURL(join(pkgDir, 'dist/modes/daemon/daemon-protocol.js')).href);
  const theirs = real.createDaemonCommandEnvelope(
    { type: 'prompt', activeSessionId: 'sess_1', message: 'hi' }, 'c1', 'mercury:run:r1', 7);
  assert.deepEqual(mine, theirs, 'envelope drifted from the daemon implementation');
  assert.equal(real.isDaemonCommandEnvelope(mine), true, 'daemon rejects our envelope');
});

test('responses, events and closing are all classified -- none discarded', () => {
  const ok = parseDaemonLine('{"id":"c1","type":"response","command":"create","success":true,"data":{"activeSessionId":"s1"}}');
  assert.deepEqual(ok, { kind: 'response', id: 'c1', command: 'create', success: true, data: { activeSessionId: 's1' } });

  const bad = parseDaemonLine('{"id":"c2","type":"response","command":"prompt","success":false,'
    + '"error":"no such session","errorInfo":{"code":"session_not_found"}}');
  assert.equal(bad.kind, 'response');
  if (bad.kind === 'response') {
    assert.equal(bad.success, false);
    assert.equal(bad.error, 'no such session');
    // The adapter previously threw every response away, so a precise code like this never reached anyone.
    assert.deepEqual((bad.errorInfo as any).code, 'session_not_found');
  }

  // session_event with meta, as the real supervisor sends it.
  const ev = parseDaemonLine('{"type":"session_event","activeSessionId":"s1","event":{"type":"message_update"},'
    + '"meta":{"id":"s1:7","sequence":7,"cursor":{"generation":"g1","sequence":7}}}');
  assert.equal(ev.kind, 'event');
  if (ev.kind === 'event') {
    assert.equal(ev.sequence, 7);
    assert.deepEqual((ev.cursor as any).generation, 'g1');
  }

  const closing = parseDaemonLine('{"type":"daemon_closing","reason":"update restart"}');
  assert.deepEqual(closing, { kind: 'closing', reason: 'update restart' });

  // Unparseable input is a reported result, never a silent return.
  assert.equal(parseDaemonLine('not json').kind, 'unparsed');
  assert.equal(parseDaemonLine('{"type":"mystery"}').kind, 'unparsed');
});

test('the fencing token never survives into a loggable hello', () => {
  const safe = helloForLogging(REAL_HELLO as any);
  assert.ok(!('supervisorOwnerToken' in safe), 'fencing token must not be logged');
  // Everything useful survives, so the omission is deliberate rather than the whole object being dropped.
  assert.equal(safe.appVersion, '0.9.1');
  assert.equal(safe.schemaRevision, 25);
  assert.ok(Array.isArray(safe.serverCapabilities));
});
test('a dialog answer is converted into the daemon form, not the flat RPC form', () => {
  // Transcribed from the vendor's own RPC->daemon bridge. The ordering is load-bearing: cancelled wins
  // over a value, and a value wins over a confirmation.
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', value: 'main' }), { requestId: 'r1', response: { value: 'main' } });
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', confirmed: true }), { requestId: 'r1', response: { confirmed: true } });
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', confirmed: false }), { requestId: 'r1', response: { confirmed: false } });
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', cancelled: true }), { requestId: 'r1', response: { cancelled: true } });
  // A cancel that also carries a value is a cancellation, not an answer.
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', cancelled: true, value: 'x' }),
    { requestId: 'r1', response: { cancelled: true } });
  // A value of null is still a value; it must not fall through to the confirm branch.
  assert.deepEqual(toDaemonUiResponse({ id: 'r1', value: null }), { requestId: 'r1', response: { value: null } });
});

test('a real session_event line is recognised, with its ordering taken from meta', () => {
  // Captured verbatim from a live supervisor turn. The line type is session_event and the sequence and
  // cursor live in meta; a parser that only reads top-level fields sees a cursor that never advances,
  // and a parser keyed on `event` drops every event the real daemon sends.
  const line = JSON.stringify({
    type: 'session_event',
    activeSessionId: 'b2171e30b7e2',
    event: { type: 'message_update', message: { role: 'assistant', content: 'PONG' } },
    meta: {
      id: 'b2171e30b7e2:12',
      protocol: { name: 'prime-agent.daemon', version: 7 },
      activeSessionId: 'b2171e30b7e2',
      sequence: 12,
      cursor: { generation: 'gen-abc', sequence: 12 },
      emittedAt: '2026-09-02T22:41:19.889Z',
    },
  });
  const parsed = parseDaemonLine(line);
  assert.equal(parsed.kind, 'event');
  if (parsed.kind === 'event') {
    assert.equal(parsed.sequence, 12);
    assert.deepEqual(parsed.cursor, { generation: 'gen-abc', sequence: 12 });
    assert.equal((parsed.event as { type: string }).type, 'message_update');
  }
});

test('session lifecycle lines are classified, not reported as unknown', () => {
  // These arrive on every real run. Leaving them `unparsed` would flood the log and hide the lines that
  // actually matter, and treating session_closed as informational would leave the run hanging.
  assert.equal(parseDaemonLine('{"type":"heartbeats_changed"}').kind, 'ignore');
  const status = parseDaemonLine(JSON.stringify({ type: 'session_status', activeSessionId: 's', recap: 'done', meta: {} }));
  assert.equal(status.kind, 'status');
  const closed = parseDaemonLine(JSON.stringify({ type: 'session_closed', activeSessionId: 's', reason: 'killed', meta: {} }));
  assert.equal(closed.kind, 'session_closed');
  if (closed.kind === 'session_closed') assert.equal(closed.reason, 'killed');
  // Something genuinely unknown is still reported.
  assert.equal(parseDaemonLine('{"type":"brand_new_thing"}').kind, 'unparsed');
});

// --- describeConnectError: a stale socket must not report a bare errno ---------------------------

test('a stale socket (ECONNREFUSED) explains that the file exists but its supervisor is gone', () => {
  const msg = describeConnectError('ECONNREFUSED', 'connect ECONNREFUSED /run/daemon.sock',
    '/run/daemon.sock', 'MERCURY_DAEMON_SOCKET');
  // The operator needs the diagnosis, not the errno.
  assert.match(msg, /nothing is listening/);
  assert.match(msg, /socket file exists/);
  assert.match(msg, /crashed or killed/);
  // ...and the next action.
  assert.match(msg, /prime-agent status/);
  assert.match(msg, /MERCURY_AGENT_MODE=rpc/);
  assert.match(msg, /MERCURY_DAEMON_SOCKET/, 'names where the path came from');
});

test('a socket that vanished mid-connect is described as a restart, not a missing config', () => {
  const msg = describeConnectError('ENOENT', 'connect ENOENT /run/daemon.sock', '/run/daemon.sock', 'default');
  assert.match(msg, /disappeared between discovery and connect/);
  assert.match(msg, /prime-agent status/);
});

test('a permission problem names uid, because that is the actual fix', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const msg = describeConnectError(code, 'connect EACCES', '/run/daemon.sock', 'default');
    assert.match(msg, /permission denied/i, code);
    assert.match(msg, /uid|another user/, code);
  }
});

test('an unrecognised errno keeps its code and message instead of inventing a diagnosis', () => {
  const msg = describeConnectError('EHOSTUNREACH', 'no route to socket', '/run/daemon.sock', 'default');
  assert.match(msg, /EHOSTUNREACH/);
  assert.match(msg, /no route to socket/);
  // Must not claim the supervisor crashed when we do not know that.
  assert.doesNotMatch(msg, /crashed or killed/);
});
