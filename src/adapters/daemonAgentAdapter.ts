/**
 * DaemonAgentAdapter: run a Mercury Run against a resident PrimeAgent daemon supervisor.
 *
 * Enable with MERCURY_AGENT_MODE=daemon. RPC remains the default and the only mode that does not
 * require a supervisor to already be running.
 *
 * Transport, verified against prime-agent 0.9.1 rather than inferred (see
 * docs/daemon-agent-sessions.md section 3):
 *
 *   - The PUBLIC supervisor transport is newline-delimited JSON in BOTH directions, on the socket
 *     `prime-agent status` reports -- `$TMPDIR/prime-agent-<uid>/daemon.sock` by default.
 *   - The first line on connect is a `daemon_hello` carrying protocol version, schema revision and
 *     the server capability list. It is validated, not ignored.
 *   - Commands must be wrapped in an envelope. A bare `{type:"prompt",...}` is not answered at all,
 *     which is indistinguishable from an agent that is merely thinking.
 *   - `prompt` requires an `activeSessionId` obtained from a prior `create`, and events reach a
 *     client that has `attach`ed to that session.
 *
 * What this file deliberately does NOT do:
 *
 *   - **It never spawns a daemon.** The supervisor is a per-uid background service that owns live
 *     agent sessions; a Mercury worker starting one would be starting a service it does not own,
 *     and a spawned process inherits `PRIME_AGENT_INTERNAL_DAEMON_WORKER` whenever Mercury itself
 *     runs inside an agent session, which yields the internal worker transport instead of the public
 *     one. If no supervisor is reachable, this fails with an actionable message.
 *   - **It never uses the internal worker transport.** That path is gated by
 *     `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN` and is free to change without notice.
 *   - **It never logs `supervisorOwnerToken`.** It is a fencing token for supervisor update handoff,
 *     not a credential for Mercury.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { attachJsonlLineReader, serializeJsonLine } from './rpc/jsonl.ts';
import { createExitGate, rearmExitGate, settleExit } from './exitSettlement.ts';
import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext } from '../domain/types.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';
import { EventTranslator, buildExtensionUiResponse, isRecord, type RpcEvent } from './eventTranslation.ts';
import {
  buildCommandEnvelope, checkHello, checkSocketPath, helloForLogging, looksPrivateFramed,
  parseDaemonLine, toDaemonUiResponse, describeConnectError, MERCURY_DAEMON_PROTOCOL_VERSION, PRIVATE_TRANSPORT_HINT, type DaemonHello,
} from './daemonProtocol.ts';

/**
 * Translate the CLI-style provider/model flags into the subset of `create` config Mercury knows how
 * to set. Returns the config plus any flags it could not place, so the caller can report them.
 */
export function sessionConfigFromArgs(args: string[]): { config: Record<string, unknown>; ignored: string[] } {
  const config: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === '--model' && value) { config.model = value; i++; continue; }
    if (flag === '--provider' && value) { config.provider = value; i++; continue; }
    if (flag === '--thinking' && value) { config.thinking = value; i++; continue; }
    if (flag.startsWith('--')) {
      // Consume a value only for flags we know take one; a bare boolean flag must not swallow the
      // next token and report the wrong thing as ignored.
      ignored.push(flag);
      continue;
    }
    ignored.push(flag);
  }
  return { config, ignored };
}

const CONTEXT_FILE = '.mercury-context.json';
const SESSION_DIR_NAME = '.mercury-sessions';

/** Raised when the daemon is reachable but speaks something Mercury must not pretend to understand. */
export class DaemonProtocolError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DaemonProtocolError';
    this.details = details;
  }
}

export interface DaemonSessionIdentity {
  runId: string;
  activeSessionId: string;
  /** Supervisor generation the session was created under; a change means replay is unavailable. */
  generation: string | null;
}

export interface DaemonAgentAdapterOptions {
  /** Explicit supervisor socket. Wins over MERCURY_DAEMON_SOCKET and the default path. */
  socketPath?: string;
  /** Session directory name inside the workspace. */
  sessionDirName?: string;
  /** Optional sandbox manager; a run requesting isolation cannot be served by daemon mode (see below). */
  sandbox?: SandboxManager;
  /** Owning worker id; propagated for log correlation (section 25). */
  workerId?: string;
  /**
   * Provider/model flags from MERCURY_PRIMEAGENT_ARGS. The adapter spawns no process, so these are
   * forwarded into the `create` config instead of a command line. Anything unrecognised is reported
   * rather than dropped: a run that silently used the supervisor's default model because a flag went
   * missing is the kind of surprise this adapter's history is full of.
   */
  args?: string[];
  /** Unused; kept so callers do not break. The adapter spawns no process. */
  env?: Record<string, string>;
  /** Bound on the completion release, so a wedged supervisor cannot stall a finished run. */
  detachTimeoutMs?: number;
  /**
   * Leave sessions running after a successful run. Only meaningful together with reattach, which is not
   * implemented; see finishCompleted(). Off by default so a run does not strand a supervisor worker.
   */
  keepSessionsAlive?: boolean;
  /** Called once the daemon has assigned a session, before the first prompt is sent. */
  onSessionIdentity?: (identity: DaemonSessionIdentity) => void;
  /** Timeouts, overridable for tests. */
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
  commandTimeoutMs?: number;
  logger?: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

interface HelloWaiter {
  resolve: (hello: unknown) => void;
  reject: (err: Error) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

interface DaemonSession {
  runId: string;
  socket: Socket;
  detachReader: () => void;
  /** Per-start client nonce; see clientId(). */
  clientNonce: string;
  /** Set while we are releasing the session ourselves, so our own closure is not read as a crash. */
  releasing?: boolean;
  /** Handshakes waiting on THIS socket. Never shared across sessions; see failHelloWaiters(). */
  helloWaiters: Set<HelloWaiter>;
  /** First bytes seen on the socket, used to recognise the internal framed transport. */
  firstBytes?: Buffer;
  socketPath?: string;
  translator: EventTranslator;
  protocolVersion: number;
  capabilities: string[];
  generation: string | null;
  activeSessionId: string | null;
  /** Highest daemon sequence applied; recovery metadata, kept separate from Mercury's own sequence. */
  cursor: number;
  pending: Map<string, Pending>;
  nextCommandId: number;
  done: boolean;
  terminated: boolean;
  cancelled: boolean;
  /** Provided by createExitGate(); declared because settleExit() requires it. */
  exitSettled: boolean;
  queue: AgentEvent[];
  waiters: ((ev: AgentEvent) => void)[];
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };

/**
 * Resolve the run's exit promise exactly once.
 *
 * Guards on `exitSettled` ALONE, never on `done`. `done` is set by terminate() and cancel() while the
 * exit is still unresolved, so a guard that consults it refuses to settle on precisely the paths that
 * need it most (issue #55). Same rule as primeAgentAdapter.ts.
 */
export class DaemonAgentAdapter implements AgentAdapter {
  private opts: DaemonAgentAdapterOptions;
  private sessions = new Map<string, DaemonSession>();
  private cmd: string;

  constructor(cmd: string, opts: DaemonAgentAdapterOptions = {}) {
    this.cmd = cmd;
    this.opts = opts;
  }

  /**
   * Resolve which socket to talk to, in this order:
   *   1. an explicit option (tests, and the only way to point at a non-default supervisor)
   *   2. MERCURY_DAEMON_SOCKET, because the operator knows best
   *   3. the default per-uid supervisor path
   * There is deliberately no "start one ourselves" step.
   */
  resolveSocketPath(): { path: string; source: string } {
    if (this.opts.socketPath) return { path: this.opts.socketPath, source: 'option' };
    const fromEnv = process.env.MERCURY_DAEMON_SOCKET;
    if (fromEnv && fromEnv.trim() !== '') return { path: fromEnv.trim(), source: 'MERCURY_DAEMON_SOCKET' };
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    return { path: join(tmpdir(), `prime-agent-${uid}`, 'daemon.sock'), source: 'default supervisor path' };
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;

    // A supervisor runs in the user's own context and cannot be placed inside this run's container.
    // Running an isolation-requesting run UNSANDBOXED because the transport happens to be different
    // would be a silent security downgrade, so refuse and let the operator choose RPC mode instead.
    const sandbox = this.opts.sandbox;
    if (sandbox?.requiresSandbox(context.run)) {
      throw new DaemonProtocolError(
        'daemon mode cannot sandbox a run: the supervisor is a per-uid service outside this worker. '
        + 'Run this task with MERCURY_AGENT_MODE=rpc, or mount the supervisor socket into the sandbox '
        + 'and set MERCURY_DAEMON_SOCKET (docs/daemon-agent-sessions.md section 12 item 6).');
    }

    writeFileSync(join(workspacePath, CONTEXT_FILE), JSON.stringify({
      runId,
      task: context.run.task,
      repository: context.repository,
      repositories: context.repositories,
      workspace: workspacePath,
      branch: context.workspace.branch,
      baseCommit: context.workspace.baseCommit,
      skills: context.skills.map((s) => ({ id: s.id, version: s.version, hash: s.hash })),
      constraints: context.constraints,
    }, null, 2));

    const sessionDir = join(workspacePath, this.opts.sessionDirName ?? SESSION_DIR_NAME);
    mkdirSync(sessionDir, { recursive: true });

    const { path: socketPath, source } = this.resolveSocketPath();
    const pathErr = checkSocketPath(socketPath);
    if (pathErr) throw new DaemonProtocolError(pathErr, { socketPath });
    if (!existsSync(socketPath)) {
      throw new DaemonProtocolError(
        `no daemon supervisor socket at ${socketPath} (from ${source}). Start the PrimeAgent `
        + 'background service, or run `prime-agent status` to see what is running. To use RPC mode '
        + 'instead, set MERCURY_AGENT_MODE=rpc.',
        { socketPath, source });
    }

    const socket = await this.connect(socketPath, source);
    const session: DaemonSession = {
      runId, socket, socketPath,
      clientNonce: randomBytes(6).toString('hex'),
      helloWaiters: new Set<HelloWaiter>(),
      detachReader: () => undefined,
      translator: new EventTranslator(),
      protocolVersion: 0, capabilities: [], generation: null, activeSessionId: null, cursor: 0,
      pending: new Map(), nextCommandId: 0,
      done: false, terminated: false, cancelled: false,
      queue: [], waiters: [],
      ...createExitGate(),
    };
    this.sessions.set(runId, session);

    this.attachTransport(session);

    try {
      const hello = await this.awaitHello(session);
      if (this.sawFramedBytes(session)) {
        throw new DaemonProtocolError(`daemon handshake was not JSONL. ${PRIVATE_TRANSPORT_HINT}`, { socketPath });
      }
      const check = checkHello(hello);
      if (!check.ok) {
        throw new DaemonProtocolError(
          `refusing to run against this daemon: ${check.reason} (observed ${check.observed}, expected ${check.expected})`,
          { socketPath, hello: helloForLogging(hello ?? {}) });
      }
      session.protocolVersion = check.protocolVersion;
      session.capabilities = check.capabilities;
      session.generation = check.generation;
      this.opts.logger?.info('daemon handshake accepted', {
        runId, protocolVersion: check.protocolVersion,
        appVersion: (hello as Partial<DaemonHello>)?.appVersion,
        schemaRevision: (hello as Partial<DaemonHello>)?.schemaRevision,
      });

      // Create the session, then record its identity BEFORE prompting: if the worker dies mid-run,
      // reattach is only possible if the id survived, and storing it after the prompt leaves a window
      // in which the recovery path cannot work.
      const { config: argConfig, ignored } = sessionConfigFromArgs(this.opts.args ?? []);
      if (ignored.length > 0) {
        this.opts.logger?.warn('daemon mode ignored agent flags it cannot express as session config',
          { runId, ignored });
      }
      const created = await this.command<{ activeSessionId?: string }>(session, {
        type: 'create', noSession: true,
        config: { cwd: workspacePath, sessionDir: sessionDir, ...argConfig },
      });
      const activeSessionId = created?.activeSessionId;
      if (typeof activeSessionId !== 'string' || activeSessionId === '') {
        throw new DaemonProtocolError('daemon create returned no activeSessionId', { created });
      }
      session.activeSessionId = activeSessionId;
      this.opts.onSessionIdentity?.({ runId, activeSessionId, generation: session.generation });

      // attach is what subscribes this connection to the session's events; prompt alone does not.
      await this.command(session, {
        type: 'attach', activeSessionId, clientId: this.clientId(runId, session.clientNonce),
        // extension_ui is not cosmetic. The supervisor only delivers DIALOG requests (select/confirm/
        // input) when some attached client advertises it, so attaching without it means an agent that
        // asks the user a question is never forwarded to Mercury and the run waits on a dialog nobody
        // was told about. The capability folds into the same set the older supportsExtensionUi flag did.
        capabilities: ['event_sequence', 'extension_ui', 'slim_attach', 'chunked_snapshot', 'attach_snapshot'],
      });

      await this.command(session, {
        type: 'prompt', activeSessionId,
        message: `Work on the task in ${CONTEXT_FILE}. Task: ${context.run.task}`,
      });
    } catch (err) {
      // Fail fast and loudly (G3): a protocol mismatch must not become a run that times out minutes later.
      session.done = true;
      settleExit(session, { code: 1, signal: null, reason: 'failed' });
      this.destroy(session);
      throw err;
    }

    return this.makeHandle(session);
  }

  /**
   * The supervisor binds a session to the clientId that created it, and does NOT clear that binding
   * when the session is killed: a later `create` under the same clientId returns the dead session's
   * `activeSessionId`, and the `attach` that follows fails with `Unknown active session` -- for that
   * run, forever. A stable id is therefore only safe while the session is alive.
   *
   * Each start() gets its own nonce so a retry, a cancelled run, or a worker that restarts after a
   * kill always creates a live session. Reuse across runs would want the opposite (a stable id plus
   * reattach), which is open question 1 and is not implemented; `resume()` throws rather than
   * pretending to support it.
   */
  private clientId(runId: string, nonce: string): string {
    return `mercury:run:${runId}${this.opts.workerId ? `:worker:${this.opts.workerId}` : ''}:s${nonce}`;
  }

  /**
   * Connect, translating a bare errno into an actionable message.
   *
   * Retrying is deliberately absent. Mercury never starts the supervisor (design §7.5), so waiting on a
   * socket it does not own means guessing about someone else's lifecycle; a fast, specific failure that
   * names `prime-agent status` serves an operator better than a silent backoff that eventually gives up.
   */
  private connect(path: string, source: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DaemonProtocolError(`timed out connecting to daemon socket ${path}`, { socketPath: path }));
      }, this.opts.connectTimeoutMs ?? 5_000);
      timer.unref?.();
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('error', (err) => {
        clearTimeout(timer);
        const e = err as NodeJS.ErrnoException;
        reject(new DaemonProtocolError(describeConnectError(e.code ?? '', e.message, path, source),
          { socketPath: path, source, code: e.code }));
      });
    });
  }

  /**
   * Wire a connected socket to the line reader and the session.
   *
   * The reader is attached BEFORE the hello is consumed on purpose. A single data event can carry the
   * hello plus the first events; parsing the hello separately and then attaching a fresh reader is what
   * discarded every frame that shared the hello's write (issue #68). Both start() and describeSupervisor()
   * go through here, because a second hand-rolled copy is how the two paths would drift apart.
   */
  private attachTransport(session: DaemonSession): void {
    const socket = session.socket;
    const onFirst = (chunk: Buffer): void => {
      const bytes = Buffer.concat([session.firstBytes ?? Buffer.alloc(0), chunk]).subarray(0, 64);
      session.firstBytes = bytes;
      // Detect the internal transport the moment its bytes arrive. Framed bytes contain no newline, so
      // waiting for a hello line before classifying them means the connection simply times out -- the
      // same silent hang this adapter exists to eliminate, only slower.
      if (looksPrivateFramed(bytes)) {
        socket.off('data', onFirst);
        this.failHelloWaiters(session, new DaemonProtocolError(
          `daemon handshake was not JSONL. ${PRIVATE_TRANSPORT_HINT}`, { socketPath: session.socketPath ?? '' }));
      }
    };
    socket.on('data', onFirst);
    socket.on('close', () => this.onSocketClosed(session, 'close'));
    socket.on('error', (err) => this.onSocketClosed(session, `error: ${(err as Error).message}`));

    session.detachReader = attachJsonlLineReader(socket, (line) => this.onLine(session, line), {
      maxLineLength: 32 * 1024 * 1024,
      onLineOverflow: (line) => {
        // A dropped record is a hole in the run's event history. Say so rather than continuing quietly.
        this.opts.logger?.warn('daemon event line exceeded the reader cap and was dropped',
          { runId: session.runId, bytes: line.length });
      },
    });
  }

  private sawFramedBytes(session: DaemonSession): boolean {
    return !!session.firstBytes && looksPrivateFramed(session.firstBytes);
  }

  private awaitHello(session: DaemonSession): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.helloWaiters.delete(entry);
        reject(new DaemonProtocolError(
          'daemon did not send a daemon_hello within the handshake window; the socket may not be a '
          + 'supervisor, or it is a session worker on the internal transport'));
      }, this.opts.helloTimeoutMs ?? 5_000);
      timeout.unref?.();
      const entry: HelloWaiter = {
        resolve: (hello) => { clearTimeout(timeout); session.helloWaiters.delete(entry); resolve(hello); },
        reject: (err) => { clearTimeout(timeout); session.helloWaiters.delete(entry); reject(err); },
      };
      session.helloWaiters.add(entry);
    });
  }

  /**
   * Reject this session's pending handshakes only.
   *
   * The waiters used to live on the adapter, which meant a second connection's hello resolved the
   * FIRST session's waiter (handing it another socket's hello) and a second connection's framed bytes
   * failed every other handshake in flight. Harmless while the worker drives one Run at a time, and a
   * cross-Run misfire the moment it does not.
   */
  private failHelloWaiters(session: DaemonSession, err: Error): void {
    for (const waiter of [...session.helloWaiters]) waiter.reject(err);
    session.helloWaiters.clear();
  }

  private onLine(session: DaemonSession, line: string): void {
    if (line.trim() === '') return;
    const parsed = parseDaemonLine(line);
    switch (parsed.kind) {
      case 'hello':
        for (const waiter of [...session.helloWaiters]) waiter.resolve(parsed.hello);
        session.helloWaiters.clear();
        return;
      case 'response': {
        const p = session.pending.get(parsed.id);
        if (!p) {
          // An unsolicited response is worth a log: it usually means a command timed out and the
          // answer arrived afterwards, which is information about daemon latency, not noise to eat.
          this.opts.logger?.warn('daemon response for an unknown or expired command id',
            { runId: session.runId, id: parsed.id, command: parsed.command });
          return;
        }
        session.pending.delete(parsed.id);
        clearTimeout(p.timer);
        if (!parsed.success) {
          const info = isRecord(parsed.errorInfo) ? parsed.errorInfo : undefined;
          const code = info && typeof info.code === 'string' ? info.code : undefined;
          // The daemon often answers a refusal with a precise code. Surfacing it is the difference
          // between an operator knowing what happened and reading a timeout.
          p.reject(new DaemonProtocolError(
            `daemon refused ${p.command}${code ? ` (${code})` : ''}: ${parsed.error ?? 'no reason given'}`,
            { command: p.command, code, errorInfo: parsed.errorInfo }));
          return;
        }
        p.resolve(parsed.data);
        return;
      }
      case 'event': {
        if (typeof parsed.sequence === 'number') session.cursor = Math.max(session.cursor, parsed.sequence);
        // The translator switches on `type`, so an event without one is not translatable. Feeding it
        // in anyway would mean casting away the one field the translator depends on; a daemon that
        // sends shapeless events should be visible in the log rather than silently contributing
        // nothing to the run's history.
        if (typeof parsed.event.type !== 'string') {
          this.opts.logger?.warn('daemon event carried no string type and was not translated',
            { runId: session.runId, sequence: parsed.sequence, keys: Object.keys(parsed.event) });
          return;
        }
        const events = session.translator.translate(parsed.event as unknown as RpcEvent);
        for (const ev of events) {
          this.push(session, ev);
          if (ev.type === 'agent.end') void this.finishCompleted(session);
        }
        return;
      }
      case 'closing': {
        // The supervisor is shutting down. We stop cleanly -- no hang, no half-read socket -- but the
        // run is recorded as an AGENT failure and is not auto-retried, because AgentExitReason has no
        // way to report an infrastructure failure from inside the drive loop. The message the operator
        // sees ("Agent exited with code null") blames the agent for the supervisor's shutdown.
        // Design section 8 asks for a requeue instead. Tracked in issue #188; do not describe this as
        // graceful requeueing here again -- an earlier version of this comment did, and it was wrong.
        this.opts.logger?.warn('daemon is closing', { runId: session.runId, reason: parsed.reason });
        session.done = true;
        // Infrastructure, not the agent: the supervisor went away and the task was never given a
        // chance to fail. Attributing it here is what gets the run auto-retried against the next
        // supervisor instead of leaving a human to notice (issue #188).
        settleExit(session, {
          code: null, signal: 'SIGTERM', reason: 'failed', errorKind: 'infrastructure',
          message: `the daemon supervisor shut down mid-run: ${parsed.reason}`,
        });
        this.push(session, DONE);
        this.destroy(session);
        return;
      }
      case 'session_closed': {
        // The session is gone, so nothing more can arrive for this run. Without this the run would sit
        // until its command timeout and then report a timeout instead of the real reason.
        // Normal completion detaches rather than kills, so this only fires for a session that ended
        // underneath us -- and cancel/terminate have already settled the exit, which settleExit
        // preserves.
        if (session.exitSettled || session.releasing) return;
        this.opts.logger?.warn('daemon session closed before the run finished',
          { runId: session.runId, reason: parsed.reason });
        session.done = true;
        settleExit(session, { code: null, signal: null, reason: 'failed' });
        this.push(session, DONE);
        this.destroy(session);
        return;
      }
      case 'status':
        // A recap/idle marker. It carries no run state, and treating it as unknown would flood the log
        // on every turn.
        this.opts.logger?.info('daemon session status', { runId: session.runId, recap: parsed.recap });
        return;
      case 'ignore':
        return;

      case 'unparsed':
        // Reported, never swallowed. Every silent drop in the previous adapter's history became a hang.
        this.opts.logger?.warn('unrecognised daemon line', { runId: session.runId, detail: parsed.detail });
        return;
    }
  }

  private onSocketClosed(session: DaemonSession, cause: string): void {
    if (session.exitSettled) return;
    session.done = true;
    for (const [, p] of session.pending) {
      clearTimeout(p.timer);
      p.reject(new DaemonProtocolError(`daemon socket closed while awaiting ${p.command} (${cause})`));
    }
    session.pending.clear();
    settleExit(session, { code: null, signal: 'SIGPIPE', reason: 'failed' });
    this.push(session, DONE);
  }

  private command<T = unknown>(session: DaemonSession, command: Record<string, unknown> & { type: string },
    timeoutMs?: number): Promise<T> {
    const id = `c${++session.nextCommandId}`;
    const envelope = buildCommandEnvelope({
      command, id, clientId: this.clientId(session.runId, session.clientNonce), protocolVersion: session.protocolVersion,
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new DaemonProtocolError(
          `daemon did not answer ${command.type} within the command window; the supervisor is `
          + 'unreachable or wedged (a bare command with no envelope is never answered at all)'));
      }, timeoutMs ?? this.opts.commandTimeoutMs ?? 60_000);
      timer.unref?.();
      session.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, command: command.type });
      session.socket.write(serializeJsonLine(envelope));
    });
  }

  private push(session: DaemonSession, ev: AgentEvent): void {
    const waiter = session.waiters.shift();
    if (waiter) waiter(ev);
    else session.queue.push(ev);
  }

  private makeHandle(session: DaemonSession): AgentHandle {
    const gen = (): AsyncGenerator<AgentEvent> => {
      async function* events(): AsyncGenerator<AgentEvent> {
        while (true) {
          if (session.queue.length > 0) {
            const ev = session.queue.shift()!;
            if (ev.type === '__done__') return;
            yield ev;
            continue;
          }
          if (session.done) return;
          const ev = await new Promise<AgentEvent>((r) => session.waiters.push(r));
          if (ev.type === '__done__') return;
          yield ev;
        }
      }
      return events();
    };
    return {
      runId: session.runId,
      get events() { return gen(); },
      exit: session.exitPromise,
      terminate: async () => {
        session.terminated = true;
        session.cancelled = true;
        session.done = true;
        // Settle BEFORE tearing the socket down (issue #55). terminate() sets `done`, every exit
        // handler is guarded on it, and socket.destroy() fires 'close' -- which would otherwise win
        // the race and record SIGPIPE/failed for what was a deliberate stop.
        settleExit(session, { code: null, signal: 'SIGTERM', reason: 'terminated' });
        // kill destroys the session; abort alone would only stop the turn and leave a worker behind.
        if (session.activeSessionId) {
          await this.command(session, { type: 'kill', activeSessionId: session.activeSessionId })
            .catch(() => { /* already gone */ });
        }
        this.destroy(session);
      },
    };
  }

  /**
   * Normal completion: release the subscription but keep the session alive. Reuse across runs is the
   * whole point of daemon mode, so this detaches rather than kills.
   *
   * The detach has to reach the supervisor BEFORE the socket goes away. An earlier draft fired it off
   * and destroyed the socket on the next line, so the write usually never left the process: the
   * supervisor kept a subscriber attached to a closed connection, and the session could not be reattached
   * cleanly. `done` is set first so the socket's close handler cannot overwrite the exit reason (#55),
   * which is what makes it safe to await here instead of settling first.
   */
  private async finishCompleted(session: DaemonSession): Promise<void> {
    if (session.exitSettled) return;
    session.done = true;
    // Detach stops the event stream; it deliberately leaves the session running. That is the right
    // protocol move ONLY once something can come back and reattach -- and nothing can: each start()
    // uses a fresh client identity, and resume() throws until persistence and reattach exist. Leaving
    // the session live therefore strands a supervisor worker after every successful run, which is the
    // #46 process leak arriving through a different door. So release it, and keep the detach path one
    // option away from the person who implements reuse (open question 1).
    const release = this.opts.keepSessionsAlive ? 'detach' : 'kill';
    // Killing makes the supervisor announce session_closed for us. That closure is ours, not a crash,
    // and it arrives while the kill is still in flight -- so mark it before sending.
    session.releasing = release === 'kill';
    await this.command(session, { type: release, activeSessionId: session.activeSessionId ?? '' },
      this.opts.detachTimeoutMs ?? 2_000)
      .catch(() => { /* the run already succeeded; a failed release is not a run failure */ });
    settleExit(session, { code: 0, signal: null, reason: 'completed' });
    this.destroy(session);
  }

  private destroy(session: DaemonSession): void {
    session.detachReader();
    session.socket.destroy();
    this.sessions.delete(session.runId);
  }

  /**
   * Answer a pending dialog. The daemon takes an extension_ui_response command, not a prompt:
   * sending the answer as a prompt would queue it as new work instead of unblocking the turn.
   */
  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const session = this.sessions.get(runId);
    // A live session is one whose socket is still open. The first draft read `!session?.socket.destroyed`,
    // which is true exactly when the session IS healthy -- so sendInput threw on every run that was
    // actually waiting for input, and the twelve old tests never called it.
    if (!session || session.socket.destroyed) throw new Error(`No live agent session for run ${runId}`);
    const pending = session.translator.pending;
    if (!pending) throw new Error(`Run ${runId} is not waiting for input`);
    session.translator.clearPending();
    // The daemon does not take the flat RPC answer. Sending `{id, value}` here answers nothing and
    // produces no error, so the run would simply sit waiting for a dialog that was already answered.
    const { requestId, response } = toDaemonUiResponse(
      buildExtensionUiResponse(pending.requestId, pending.method, input.value));
    await this.command(session, {
      type: 'extension_ui_response', activeSessionId: session.activeSessionId ?? '', requestId, response,
    });
  }

  /**
   * Cancel a run.
   *
   * Settle BEFORE touching the socket, for the reason issue #55 established: the 'close' and 'error'
   * handlers settle the exit as SIGPIPE/failed, and a write to a broken socket can fire 'error'
   * synchronously. Settling afterwards loses that race and records a deliberate cancellation as a
   * crash. The commands are still sent -- settleExit only resolves a promise.
   */
  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.cancelled) return;
    session.cancelled = true;
    session.done = true;
    settleExit(session, { code: 130, signal: 'SIGTERM', reason: 'cancelled' });
    // abort stops the current turn; kill releases the session so no worker is left running (#46).
    if (session.activeSessionId) {
      await this.command(session, { type: 'abort', activeSessionId: session.activeSessionId }).catch(() => undefined);
      await this.command(session, { type: 'kill', activeSessionId: session.activeSessionId }).catch(() => undefined);
    }
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    this.destroy(session);
  }

  /**
   * Release per-run state once the worker is finished with the run (issues #62, #97). The worker
   * calls this AFTER handle.terminate() resolves; pruning any earlier reintroduces the #46 leak,
   * because terminate() looks the session up by runId.
   */
  dispose(runId: string): void {
    this.sessions.delete(runId);
  }

  /**
   * Resume is not supported yet. Reattach needs the persisted activeSessionId and a generation
   * comparison -- if the generation changed, replay is unavailable and the snapshot path must be taken
   * instead of assuming continuity (docs/daemon-agent-sessions.md section 7.4). Assuming continuity
   * is the #133 failure mode in a new costume, so this refuses rather than guesses.
   */
  /**
   * Read-only supervisor check: connect, validate the handshake, and ask what is there.
   *
   * Creates nothing. It exists because "is daemon mode even usable here" is the first question an
   * operator has after setting MERCURY_AGENT_MODE=daemon, and because it lets the real supervisor be
   * exercised in tests without starting an agent session.
   */
  async describeSupervisor(): Promise<{
    socketPath: string; protocolVersion: number; capabilities: string[];
    generation: string | null; appVersion: string | null; sessions: unknown;
  }> {
    const { path: socketPath, source } = this.resolveSocketPath();
    const lengthProblem = checkSocketPath(socketPath);
    if (lengthProblem) throw new DaemonProtocolError(lengthProblem, { socketPath });
    const socket = await this.connect(socketPath, source);
    try {
      const session: DaemonSession = {
        runId: 'probe', socket, socketPath,
        clientNonce: randomBytes(6).toString('hex'),
        helloWaiters: new Set<HelloWaiter>(),
        detachReader: () => undefined,
        translator: new EventTranslator(),
        protocolVersion: MERCURY_DAEMON_PROTOCOL_VERSION, capabilities: [], generation: null,
        activeSessionId: null, cursor: 0,
        pending: new Map(), nextCommandId: 0,
        done: false, terminated: false, cancelled: false,
        queue: [], waiters: [],
        ...createExitGate(),
      };
      this.attachTransport(session);
      const hello = await this.awaitHello(session);
      if (this.sawFramedBytes(session)) {
        throw new DaemonProtocolError(`daemon handshake was not JSONL. ${PRIVATE_TRANSPORT_HINT}`, { socketPath });
      }
      const checked = checkHello(hello);
      if (!checked.ok) {
        throw new DaemonProtocolError(`daemon handshake rejected: ${checked.reason}`, {
          socketPath, observed: checked.observed, expected: checked.expected,
        });
      }
      const sessions = await this.command(session, { type: 'list' }, this.opts.commandTimeoutMs ?? 10_000);
      return {
        socketPath, protocolVersion: checked.protocolVersion, capabilities: checked.capabilities,
        generation: checked.generation,
        appVersion: typeof (hello as Record<string, unknown>).appVersion === 'string'
          ? String((hello as Record<string, unknown>).appVersion) : null,
        sessions,
      };
    } finally {
      socket.destroy();
    }
  }

  async resume(runId: string, _context?: RunContext): Promise<AgentHandle> {
    throw new DaemonProtocolError('daemon resume is not implemented; refusing to guess at session continuity');
  }
}
