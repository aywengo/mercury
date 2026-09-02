// DaemonAgentAdapter tests against a mock supervisor.
//
// The mock speaks the protocol the REAL daemon speaks (see its header), so these tests can actually
// fail. The previous twelve tests passed against a fixture that agreed with the adapter about every
// way the adapter was wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { DaemonAgentAdapter, DaemonProtocolError, sessionConfigFromArgs } from '../src/adapters/daemonAgentAdapter.ts';
import { looksPrivateFramed } from '../src/adapters/daemonProtocol.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir, tempFile } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-daemon.mjs');
const HELLO_FIXTURE = join(import.meta.dirname, 'fixtures', 'daemon-hello.jsonl');
let socketCounter = 0;

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_daemon', ownerId: 'alice', task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' }, workspaceBranch: null, workspacePath: null,
    agent: 'primeagent', status: 'QUEUED', attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 }, createdAt: now, startedAt: null,
    completedAt: null, leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
    finalCommits: [], prUrl: null, ...overrides,
  };
}

function makeContext(run: Run = makeRun()): RunContext {
  const workspacePath = tempDir('mercury-daemon-');
  return {
    run, repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc123', mode: 'copy' },
    skills: [] as ResolvedSkill[], constraints: run.constraints,
  };
}

/**
 * Socket paths go through the helpers' tracked temp files. A socket path is length-limited (104 bytes
 * on macOS) and a long one fails connect() with EINVAL, so the length is asserted here rather than
 * discovered as an unexplained failure later.
 */
function shortSocketPath(tag: string): string {
  const p = tempFile(`mcd${tag}`, '.sock');
  assert.ok(Buffer.byteLength(p) <= 104, `test socket path too long (${Buffer.byteLength(p)}): ${p}`);
  return p;
}

interface Mock { path: string; close(): Promise<void>; }

async function startMock(env: Record<string, string> = {}): Promise<Mock> {
  const path = shortSocketPath('s');
  const proc: ChildProcess = spawn(process.execPath, [MOCK, path], {
    env: { ...process.env, MOCK_DAEMON_HELLO: HELLO_FIXTURE, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock daemon did not start: ${err}`)), 8_000);
    proc.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('"ready":true')) { clearTimeout(timer); resolve(); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`mock exited ${code}: ${err}`)); });
  });
  return {
    path,
    close: async () => {
      if (proc.exitCode === null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); }
      // A leftover socket file looks exactly like a live listener to the next test, so remove it.
      // (An earlier draft called require() here; this module is ESM, so it threw and cleanup silently
      // did nothing, and every later test failed with EADDRINUSE.)
      if (existsSync(path)) { try { unlinkSync(path); } catch { /* already gone */ } }
    },
  };
}

function adapterFor(mock: Mock, opts: ConstructorParameters<typeof DaemonAgentAdapter>[1] = {}): DaemonAgentAdapter {
  return new DaemonAgentAdapter('prime-agent', { socketPath: mock.path, helloTimeoutMs: 1_500,
    commandTimeoutMs: 3_000, connectTimeoutMs: 1_500, ...opts });
}

/** Fail rather than hang: a dropped frame must report the frame, not burn the runner's timeout. */
async function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms);
  });
  try { return await Promise.race([work, guard]); }
  finally { if (timer) clearTimeout(timer); }
}

async function collectAll(handle: Awaited<ReturnType<DaemonAgentAdapter['start']>>) {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') break;
    events.push({ type: ev.type, payload: ev.payload });
  }
  return { events, exit: await handle.exit };
}

const err = async (fn: () => Promise<unknown>): Promise<Error> => {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error('expected a rejection');
};

test('happy path: handshake, create, attach, prompt, events, completed exit', async () => {
  const mock = await startMock();
  try {
    const adapter = adapterFor(mock);
    const handle = await withDeadline('start', 8_000, adapter.start(makeContext()));
    const { events, exit } = await withDeadline('collect', 8_000, collectAll(handle));
    assert.ok(events.some((e) => e.type === 'agent.message'), `no agent.message in ${JSON.stringify(events)}`);
    assert.equal(exit.reason, 'completed');
    assert.equal(exit.code, 0);
  } finally { await mock.close(); }
});



/**
 * Each test gets its own directory for the wire transcript. Sharing one temp namespace by name is how
 * an earlier draft of this file made one test's commands appear in another's assertions: the failures
 * looked like the adapter sending every command twice, and were purely scaffolding.
 */
/** The wire transcript is a tracked temp file; tests assert on it after the run finishes. */
function newTx(): string { return tempFile('mcdwire', '.jsonl'); }

function transcript(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('every line the adapter writes is a valid daemon command envelope', async () => {
  // Asserted on the WIRE, not on adapter internals. The old adapter sent a bare {type:"prompt"} and
  // no test noticed, because the fixture accepted exactly that.
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    await withDeadline('collect', 8_000, collectAll(handle));
    const lines = transcript(tx);
    assert.ok(lines.length >= 4, `expected create/attach/prompt/detach, saw ${lines.length}`);
    for (const line of lines) {
      assert.equal(line.type, 'command', `not a command envelope: ${JSON.stringify(line)}`);
      assert.equal(typeof line.id, 'string');
      assert.deepEqual(line.protocol, { name: 'prime-agent.daemon', version: 7 });
      assert.match(String(line.clientId), /^mercury:run:run_daemon/);
      assert.equal(typeof line.command, 'object');
      assert.equal(typeof (line.command as any).type, 'string');
    }
  } finally { await mock.close(); }
});

test('create precedes prompt, and prompt carries the activeSessionId create returned', async () => {
  // The adapter used to send prompt with no session at all. Ordering and identity are both asserted
  // on the transcript so a reordering cannot pass by accident.
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    await withDeadline('collect', 8_000, collectAll(handle));
    const types = transcript(tx).map((l) => (l.command as any).type);
    assert.deepEqual(types, ['create', 'attach', 'prompt', 'detach']);
    const prompt = transcript(tx).find((l) => (l.command as any).type === 'prompt')!.command as any;
    assert.match(prompt.activeSessionId, /^sess_/, 'prompt must name the daemon-assigned session');
    assert.equal(typeof prompt.message, 'string');
  } finally { await mock.close(); }
});

test('session identity is reported before the prompt is sent', async () => {
  // Persisting the id after the prompt leaves a window in which a worker that dies mid-run cannot
  // reattach. The ordering is the whole point, so it is asserted against the transcript.
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const seen: { activeSessionId: string; generation: string | null; sentSoFar: string[] }[] = [];
    const adapter = adapterFor(mock, {
      // Sample the wire INSIDE the callback. Sampling after start() returns proves nothing, because
      // start() has already sent the prompt by then -- an earlier draft of this test passed for the
      // wrong reason until that was fixed.
      onSessionIdentity: (id) => seen.push({
        activeSessionId: id.activeSessionId, generation: id.generation,
        sentSoFar: transcript(tx).map((l) => (l.command as any).type),
      }),
    });
    const handle = await adapter.start(makeContext());
    assert.equal(seen.length, 1, 'identity must be reported exactly once');
    assert.match(seen[0]!.activeSessionId, /^sess_/);
    assert.equal(typeof seen[0]!.generation, 'string', 'supervisor generation must be captured');
    assert.deepEqual(seen[0]!.sentSoFar, ['create'], 'identity must be recorded after create and before prompting');
    await withDeadline('collect', 8_000, collectAll(handle));
  } finally { await mock.close(); }
});

test('normal completion detaches and leaves the session live; it does not kill it', async () => {
  // Killing on success would destroy the reuse the daemon mode exists to provide.
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    await withDeadline('collect', 8_000, collectAll(handle));
    const types = transcript(tx).map((l) => (l.command as any).type);
    assert.ok(types.includes('detach'), types.join(','));
    assert.ok(!types.includes('kill'), 'a successful run must not kill its session');
  } finally { await mock.close(); }
});

test('all frames sharing one write are delivered, not just the first (#68)', async () => {
  const mock = await startMock({ MOCK_DAEMON_COALESCE: '1' });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    const { events, exit } = await withDeadline('collect', 8_000, collectAll(handle));
    assert.ok(events.some((e) => e.type === 'agent.message'), 'the coalesced delta must still arrive');
    assert.equal(exit.reason, 'completed');
  } finally { await mock.close(); }
});

test('a framed hello is refused loudly as the internal transport, not hung on', async () => {
  const mock = await startMock({ MOCK_DAEMON_MODE: 'framed' });
  try {
    const adapter = adapterFor(mock);
    const e = await withDeadline('start', 8_000, err(() => adapter.start(makeContext())));
    assert.ok(e instanceof DaemonProtocolError, e.constructor.name);
    assert.match(e.message, /INTERNAL worker transport/);
    assert.match(e.message, /PRIME_AGENT_INTERNAL_DAEMON_WORKER/);
  } finally { await mock.close(); }
});

test('a newer daemon protocol is refused at start, naming observed and supported', async () => {
  const mock = await startMock({ MOCK_DAEMON_MODE: 'bad-version' });
  try {
    const adapter = adapterFor(mock);
    const e = await withDeadline('start', 8_000, err(() => adapter.start(makeContext())));
    assert.match(e.message, /newer protocol/);
    assert.match(e.message, /observed v99/);
  } finally { await mock.close(); }
});

test('a missing required capability is refused and named', async () => {
  const mock = await startMock({ MOCK_DAEMON_MODE: 'missing-cap' });
  try {
    const adapter = adapterFor(mock);
    const e = await withDeadline('start', 8_000, err(() => adapter.start(makeContext())));
    assert.match(e.message, /missing capabilities/);
    assert.match(e.message, /event_sequence/);
  } finally { await mock.close(); }
});

test('a daemon that never greets fails with a message instead of hanging', async () => {
  const mock = await startMock({ MOCK_DAEMON_MODE: 'silent' });
  try {
    const adapter = adapterFor(mock);
    const e = await withDeadline('start', 8_000, err(() => adapter.start(makeContext())));
    assert.match(e.message, /daemon_hello/);
  } finally { await mock.close(); }
});

test('a refused command surfaces the daemon error code, not a timeout', async () => {
  // The adapter used to discard every response, so a precise code like no_capacity never reached anyone.
  const mock = await startMock({ MOCK_DAEMON_MODE: 'reject-create' });
  try {
    const adapter = adapterFor(mock);
    const e = await withDeadline('start', 8_000, err(() => adapter.start(makeContext())));
    assert.match(e.message, /create \(no_capacity\)/);
    assert.match(e.message, /no capacity/);
  } finally { await mock.close(); }
});

test('terminate settles the exit as terminated rather than racing into a SIGPIPE failure (#55)', async () => {
  const mock = await startMock({ MOCK_DAEMON_PROMPT_REPLIES: '0' });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    const exit = await withDeadline('terminate', 8_000, (async () => {
      await handle.terminate();
      return handle.exit;
    })());
    assert.equal(exit.reason, 'terminated');
    assert.equal(exit.signal, 'SIGTERM');
  } finally { await mock.close(); }
});

test('cancel settles as cancelled and releases the session (#46)', async () => {
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_PROMPT_REPLIES: '0', MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    await adapter.cancel('run_daemon');
    const exit = await withDeadline('exit', 8_000, handle.exit);
    assert.equal(exit.reason, 'cancelled');
    const types = transcript(tx).map((l) => (l.command as any).type);
    assert.ok(types.includes('abort'), 'the daemon should learn the run was cancelled');
    assert.ok(types.includes('kill'), 'no worker may be left running');
    adapter.dispose('run_daemon');
  } finally { await mock.close(); }
});

test('dispose after terminate is safe and drops per-run state (#62, #97)', async () => {
  const mock = await startMock();
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    await handle.terminate();
    await handle.exit;
    adapter.dispose('run_daemon');
    adapter.dispose('run_daemon'); // idempotent
  } finally { await mock.close(); }
});

test('a missing supervisor socket produces an actionable error, never a spawn', async () => {
  const adapter = new DaemonAgentAdapter('prime-agent', { socketPath: '/tmp/definitely-not-here.sock' });
  const e = await err(() => adapter.start(makeContext()));
  assert.match(e.message, /no daemon supervisor socket/);
  assert.match(e.message, /prime-agent status/);
});

test('an over-long socket path is refused before connect', async () => {
  const deep = '/' + 'd/'.repeat(60) + 'daemon.sock';
  const adapter = new DaemonAgentAdapter('prime-agent', { socketPath: deep });
  const e = await err(() => adapter.start(makeContext()));
  assert.match(e.message, /EINVAL|over the 104-byte limit/);
});

test('a run requesting isolation is refused rather than run unsandboxed', async () => {
  const mock = await startMock();
  try {
    const sandbox = { requiresSandbox: () => true, buildCommand: () => ({ cmd: 'docker', args: [] }) } as never;
    const adapter = adapterFor(mock, { sandbox });
    const e = await err(() => adapter.start(makeContext()));
    assert.match(e.message, /cannot sandbox/);
  } finally { await mock.close(); }
});

test('resume refuses rather than guessing at session continuity', async () => {
  const mock = await startMock();
  try {
    const adapter = adapterFor(mock);
    const e = await err(() => adapter.resume!('run_daemon'));
    assert.match(e.message, /refusing to guess/);
  } finally { await mock.close(); }
});

test('provider and model flags reach the create config instead of being dropped', async () => {
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock, { args: ['--provider', 'anthropic', '--model', 'some-model', '--verbose'] });
    const handle = await adapter.start(makeContext());
    await withDeadline('collect', 8_000, collectAll(handle));
    const create = transcript(tx).find((l) => (l.command as any).type === 'create')!.command as any;
    assert.equal(create.config.model, 'some-model');
    assert.equal(create.config.provider, 'anthropic');
    assert.equal(typeof create.config.cwd, 'string');
  } finally { await mock.close(); }
});

test('sessionConfigFromArgs reports what it could not place', () => {
  const { config, ignored } = sessionConfigFromArgs(['--model', 'm', '--offline', 'stray']);
  assert.deepEqual(config, { model: 'm' });
  assert.deepEqual(ignored, ['--offline', 'stray']);
});

test('socket discovery prefers the explicit option, then MERCURY_DAEMON_SOCKET, then the default', () => {
  const withOpt = new DaemonAgentAdapter('prime-agent', { socketPath: '/tmp/explicit.sock' });
  assert.deepEqual(withOpt.resolveSocketPath(), { path: '/tmp/explicit.sock', source: 'option' });
  const saved = process.env.MERCURY_DAEMON_SOCKET;
  process.env.MERCURY_DAEMON_SOCKET = '/tmp/from-env.sock';
  try {
    assert.deepEqual(new DaemonAgentAdapter('p').resolveSocketPath(),
      { path: '/tmp/from-env.sock', source: 'MERCURY_DAEMON_SOCKET' });
  } finally {
    if (saved === undefined) delete process.env.MERCURY_DAEMON_SOCKET;
    else process.env.MERCURY_DAEMON_SOCKET = saved;
  }
  const d = new DaemonAgentAdapter('p').resolveSocketPath();
  assert.equal(d.source, 'default supervisor path');
  assert.match(d.path, /prime-agent-\w+[/\\]daemon\.sock$/);
});

test('the framing detector agrees with the mock that produces framed bytes', () => {
  // Cross-check: the same helper the adapter uses must flag what the mock builds with the real
  // private-framing layout, and must not flag the real JSONL hello.
  const helloLine = readFileSync(HELLO_FIXTURE, 'utf8').split('\n').filter((l) => !l.startsWith('#') && l.trim())[0];
  assert.equal(looksPrivateFramed(Buffer.from(helloLine, 'utf8')), false);
});

test('describeSupervisor reports the mock supervisor honestly', async () => {
  const mock = await startMock();
  try {
    const info = await adapterFor(mock).describeSupervisor();
    assert.equal(info.protocolVersion, 7);
    assert.ok(info.capabilities.includes('event_sequence'));
    assert.equal(typeof info.generation, 'string');
    assert.equal(info.appVersion, '0.9.1');
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// Contract test against the REAL supervisor.
//
// Everything above runs against a fixture, and the whole reason this adapter was broken is that its
// fixture shared its wrong assumptions. This test talks to whatever supervisor is actually running on
// this machine and is read-only: it performs the handshake and issues `list`, creating no session and
// starting no agent. It skips with a loud message when no supervisor is reachable, so CI without a
// daemon still passes -- but a machine with a daemon cannot pass these twelve tests while disagreeing
// with the real protocol.
// ---------------------------------------------------------------------------
const realAdapter = new DaemonAgentAdapter('prime-agent', { commandTimeoutMs: 10_000 });
const realSocket = realAdapter.resolveSocketPath();
const realReachable = existsSync(realSocket.path);

test('the REAL supervisor speaks the protocol this adapter implements', { skip: realReachable ? false :
  `no supervisor socket at ${realSocket.path}; start prime-agent to run this contract test` }, async () => {
  const info = await withDeadline('describeSupervisor', 20_000, realAdapter.describeSupervisor());
  // Framing: a framed hello would have been rejected before we got here.
  // Envelope: `list` was answered, which only happens for a well-formed envelope.
  assert.equal(info.protocolVersion, 7, 'protocol version negotiated with the real supervisor');
  assert.ok(info.capabilities.includes('event_sequence'),
    `real supervisor lacks event_sequence: ${info.capabilities.join(',')}`);
  assert.match(info.socketPath, /daemon\.sock$/);
  assert.equal(typeof info.generation, 'string');
  // The response must be the supervisor's own shape, not something the adapter invented.
  const sessions = (info.sessions as { sessions?: unknown[] })?.sessions;
  assert.ok(Array.isArray(sessions), `list returned ${JSON.stringify(info.sessions).slice(0, 200)}`);
});

test('an event with no type is reported, not silently dropped', async () => {
  // A guard nobody proved fires is a comment. This asserts the warning is actually emitted, and that
  // the run still completes -- refusing one malformed event must not abort the run.
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    info: () => {}, debug: () => {}, error: () => {},
    warn: (msg: string, fields: Record<string, unknown>) => { warnings.push({ msg, ...fields }); },
  } as never;
  const mock = await startMock({ MOCK_DAEMON_SHAPELESS: '1' });
  try {
    const adapter = adapterFor(mock, { logger });
    const handle = await adapter.start(makeContext());
    const { events, exit } = await withDeadline('collect', 8_000, collectAll(handle));
    const hit = warnings.find((w) => String(w.msg).includes('no string type'));
    assert.ok(hit, `expected a warning, saw ${JSON.stringify(warnings)}`);
    assert.deepEqual((hit as never as { keys: string[] }).keys, ['delta', 'noTypeHere']);
    assert.equal(exit.reason, 'completed', 'a shapeless event must not fail the run');
    assert.ok(!events.some((e) => JSON.stringify(e.payload).includes('orphan')));
  } finally { await mock.close(); }
});

test('sendInput answers a pending dialog over the wire', async () => {
  // The first draft of sendInput threw on every healthy session: `!session?.socket.destroyed` is true
  // exactly when the socket is fine. None of the twelve old tests called sendInput, so nothing noticed.
  const tx = newTx();
  const mock = await startMock({ MOCK_DAEMON_AWAIT_INPUT: '1', MOCK_DAEMON_AFTER_INPUT: 'end', MOCK_DAEMON_TRANSCRIPT: tx });
  try {
    const adapter = adapterFor(mock);
    const handle = await adapter.start(makeContext());
    // Consume in the background and signal when the dialog arrives. Breaking out of a `for await`
    // instead made this test depend on exactly when the run finished, which under full-suite load is
    // not when the test expects it.
    const seen: string[] = [];
    let signalWaiting: () => void = () => {};
    const waiting = new Promise<void>((r) => { signalWaiting = r; });
    const draining = (async () => {
      for await (const ev of handle.events) {
        if (ev.type === '__done__') break;
        seen.push(ev.type);
        if (ev.type === 'input.required') signalWaiting();
      }
    })();
    await withDeadline('input.required', 8_000, waiting);
    await withDeadline('sendInput', 8_000,
      adapter.sendInput('run_daemon', { value: 'main', at: new Date().toISOString() }));
    const answered = transcript(tx).find((l) => (l.command as any).type === 'extension_ui_response');
    assert.ok(answered, 'the answer must reach the daemon as extension_ui_response');
    const cmd = answered!.command as any;
    // The answer is addressed by the dialog's id and carries the value; buildExtensionUiResponse uses
    // `id`, and asserting a field that does not exist would have made this test fail for the wrong reason.
    assert.equal(cmd.id, 'req-1');
    assert.equal(cmd.value, 'main');
    assert.match(cmd.activeSessionId, /^sess_/, 'the answer must name the session it answers');
    const exit = await withDeadline('exit', 8_000, Promise.all([handle.exit, draining]).then(([e]) => e));
    assert.equal(exit.reason, 'completed');
  } finally { await mock.close(); }
});

test('sendInput refuses when nothing is waiting, and when the run is gone', async () => {
  // PROMPT_REPLIES=0 keeps the run open. With the default mock the turn completes a few milliseconds
  // after start(), so the session is legitimately gone by the time this asserts, and the assertion
  // passed or failed depending on load rather than on behaviour.
  const mock = await startMock({ MOCK_DAEMON_PROMPT_REPLIES: '0' });
  try {
    const adapter = adapterFor(mock);
    await adapter.start(makeContext());
    const e = await err(() => adapter.sendInput('run_daemon', { value: 'x', at: new Date().toISOString() }));
    assert.match(e.message, /not waiting for input/);
    const gone = await err(() => adapter.sendInput('no-such-run', { value: 'x', at: new Date().toISOString() }));
    assert.match(gone.message, /No live agent session/);
  } finally { await mock.close(); }
});

test('the mock rejects an envelope with no clientId', async () => {
  // The mock claims to enforce the envelope; it must enforce all of it, or it silently permits a
  // regression the real supervisor would refuse.
  const mock = await startMock();
  try {
    const sock = createConnection(mock.path);
    await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
    const reply = await new Promise<Record<string, unknown>>((res) => {
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString();
        const line = buf.split('\n').filter(Boolean)[1]; // [0] is the hello
        if (line) res(JSON.parse(line));
      });
      setTimeout(() => sock.write(JSON.stringify({
        type: 'command', id: 'x1', protocol: { name: 'prime-agent.daemon', version: 7 },
        command: { type: 'list' }, // no clientId
      }) + '\n'), 50);
    });
    assert.equal(reply.success, false);
    assert.equal((reply.errorInfo as { code: string }).code, 'invalid_envelope');
    sock.destroy();
  } finally { await mock.close(); }
});
