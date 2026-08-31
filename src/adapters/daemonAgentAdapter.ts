// DaemonAgentAdapter: optional PrimeAgent integration via the daemon socket.
// (Mercury.md sections 8, 31; roadmap item 9.)
//
// The prime-agent daemon (`prime-agent --mode daemon --daemon-socket <path>`) is a
// resident supervisor that owns long-lived sessions. Its public contract (daemon.md)
// keeps the RPC JSONL framing for commands/events; the daemon adds a 4-byte
// big-endian length prefix per frame and a `daemon_hello` handshake frame on connect.
//
// This adapter:
//   - spawns the daemon (or attaches to an existing socket),
//   - performs the hello handshake (reads the first frame, ignores it),
//   - then speaks the SAME RPC commands as rpcClient.ts over the socket,
//   - translates events into Mercury domain events (shared logic with PrimeAgentAdapter).
//
// RPC mode remains the default; enable this with MERCURY_AGENT_MODE=daemon.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext,
} from '../domain/types.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';
import { EventTranslator, buildExtensionUiResponse } from './eventTranslation.ts';

const CONTEXT_FILE = '.mercury-context.json';
const SESSION_DIR_NAME = '.mercury-sessions';

export interface DaemonAgentAdapterOptions {
  /** Extra CLI args passed to prime-agent (e.g. --provider, --model). */
  args?: string[];
  /** Session directory name inside the workspace. */
  sessionDirName?: string;
  /** Optional sandbox manager; when set and the run requests isolation, the daemon
   *  process runs inside a container with the run's resource/network limits. */
  sandbox?: SandboxManager;
  /** Owning worker id; propagated to the agent process for log correlation (section 25). */
  workerId?: string;
  /** Extra env vars for the spawned process (tests use this to point at the mock). */
  env?: Record<string, string>;
}

interface DaemonSession {
  runId: string;
  socket: Socket | null;
  proc: ChildProcess | null;
  sessionFile: string | null;
  translator: EventTranslator;
  done: boolean;
  cancelled: boolean;
  terminated: boolean;
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
 * Guards on `exitSettled` ALONE, never on `done`. `done` is set by terminate() and cancel()
 * while the exit is still unresolved, so a guard that consults it refuses to settle on
 * precisely the paths that need it most (issue #55). Same shape as settleExit() in
 * primeAgentAdapter.ts, which already gets this right.
 */
function settleExit(session: DaemonSession, exit: AgentExit): void {
  if (session.exitSettled) return;
  session.exitSettled = true;
  session.exitResolve(exit);
}

export class DaemonAgentAdapter implements AgentAdapter {
  private cmd: string;
  private opts: DaemonAgentAdapterOptions;
  private sessions = new Map<string, DaemonSession>();

  constructor(cmd: string, opts: DaemonAgentAdapterOptions = {}) {
    this.cmd = cmd;
    this.opts = opts;
  }

  /** Wrap the spawn command in a container when the run requests isolation. */
  private wrapForSandbox(run: RunContext, args: string[]): { cmd: string; args: string[] } {
    const sandbox = this.opts.sandbox;
    if (!sandbox || !sandbox.requiresSandbox(run.run)) return { cmd: this.cmd, args };
    // The run row may not have workspacePath persisted yet; the workspace object
    // always carries the real path.
    const runWithWs = { ...run.run, workspacePath: run.run.workspacePath ?? run.workspace.path };
    const wrapped = sandbox.buildCommand(runWithWs, this.cmd, args);
    return { cmd: wrapped.cmd, args: wrapped.args };
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;

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

    const session: DaemonSession = {
      runId,
      socket: null,
      proc: null,
      sessionFile: null,
      translator: new EventTranslator(),
      done: false,
      cancelled: false,
      terminated: false,
      exitSettled: false,
      queue: [],
      waiters: [],
      exitPromise: undefined as unknown as Promise<AgentExit>,
      exitResolve: undefined as unknown as (exit: AgentExit) => void,
    };
    session.exitPromise = new Promise<AgentExit>((resolve) => {
      session.exitResolve = resolve;
    });
    this.sessions.set(runId, session);

    const socketPath = join(sessionDir, 'daemon.sock');
    const extra = this.opts.args ?? [];
    // If the first extra arg is a script path (mock fixture), it must come BEFORE the
    // flags so node treats it as the script. Production usage passes provider/model
    // flags only, so the binary stays first.
    const scriptFirst = extra.length > 0 && /\.(mjs|js|cjs)$/.test(extra[0]) && existsSync(extra[0]);
    const argv = scriptFirst ? [extra[0], '--mode', 'daemon', '--daemon-socket', socketPath, '--no-session', ...extra.slice(1)]
      : ['--mode', 'daemon', '--daemon-socket', socketPath, '--no-session', ...extra];
    const spawnCmd = this.wrapForSandbox(context, argv);
    const traceEnv: Record<string, string> = { MERCURY_RUN_ID: runId, MERCURY_TRACE_ID: runId };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;
    const proc = spawn(spawnCmd.cmd, spawnCmd.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...traceEnv, ...this.opts.env },
    });
    session.proc = proc;
    proc.stderr?.on('data', (d: Buffer) => {
      // daemon logs to stderr; surface as debug only
      process.stderr.write(`[daemon] ${d.toString()}`);
    });
    proc.on('error', (err) => {
      session.done = true;
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    });
    proc.on('exit', (code, signal) => {
      session.done = true;
      settleExit(session, { code: code ?? 1, signal, reason: code === 0 ? 'completed' : 'failed' });
    });

    // Wait for the socket to appear, connect, and consume the hello frame.
    await waitForSocket(socketPath, 10_000);
    const socket = await connectSocket(socketPath);
    session.socket = socket;
    await readFrame(socket); // daemon_hello — ignored

    // Send the initial prompt (same as RPC mode) so the agent starts working.
    socket.write(frame({ type: 'prompt', message: `Work on the task in .mercury-context.json. Task: ${context.run.task}` }));

    // Wire incoming frames: responses (with id) and events (no id).
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) break;
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) break;
        const frame = buffer.subarray(4, 4 + len).toString('utf8');
        buffer = buffer.subarray(4 + len);
        this.handleFrame(session, frame);
      }
    });
    // These two guarded on `!session.done` alone -- never on exitSettled -- so they could
    // call exitResolve a second time after agent.end had already settled the exit. The
    // promise ignores a repeat resolve so the outcome was usually harmless, but it made the
    // settlement rule differ per site, which is how terminate() ended up settling nothing.
    socket.on('close', () => {
      session.done = true;
      settleExit(session, { code: null, signal: 'SIGPIPE', reason: 'failed' });
    });
    socket.on('error', () => {
      session.done = true;
      settleExit(session, { code: null, signal: 'SIGPIPE', reason: 'failed' });
    });

    return this.makeHandle(session);
  }

  private handleFrame(session: DaemonSession, frame: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'response') return; // command ack — correlation handled by caller
    const events = session.translator.translate(msg as never);
    for (const ev of events) {
      this.push(session, ev);
      if (ev.type === 'agent.end') {
        // Agent finished; resolve the exit promise (the daemon keeps the socket open).
        session.done = true;
        settleExit(session, { code: Number((msg.result ?? 0)), signal: null, reason: 'completed' });
      }
    }
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
          if (session.queue.length > 0) yield session.queue.shift()!;
          else if (session.done) return;
          else yield await new Promise<AgentEvent>((r) => session.waiters.push(r));
        }
      }
      return events();
    };
    return {
      runId: session.runId,
      get events() {
        return gen();
      },
      exit: session.exitPromise,
      terminate: async () => {
        session.terminated = true;
        session.cancelled = true;
        session.done = true;
        // Settle BEFORE tearing the socket down. terminate() sets `done`, and every exit
        // handler here was guarded on `done`, so none of them would settle afterwards:
        // handle.exit never resolved and the worker sat in
        // Promise.race([handle.exit, sleep(10_000)]) for the full timeout, then reported an
        // invented SIGKILL/terminated exit instead of this one (issue #55).
        //
        // Settling first also fixes the reported reason. socket.destroy() fires 'close',
        // which would otherwise race to settle the exit as SIGPIPE/failed.
        settleExit(session, { code: null, signal: 'SIGTERM', reason: 'terminated' });
        session.socket?.destroy();
        session.proc?.kill('SIGTERM');
      },
    };
  }

  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session?.socket) throw new Error(`No live agent session for run ${runId}`);
    const pending = session.translator.pending;
    if (!pending) throw new Error(`Run ${runId} is not waiting for input`);
    const { requestId, method } = pending;
    session.socket.write(frame({ type: 'extension_ui_response', ...buildExtensionUiResponse(requestId, method, input.value) }));
    session.translator.clearPending();
  }

  /**
   * Release per-run state once the worker is finished with the run (issues #62, #97).
   * The worker calls this after handle.terminate() has resolved; see AgentAdapter.dispose
   * for why pruning any earlier reintroduces the #46 process leak.
   */
  dispose(runId: string): void {
    this.sessions.delete(runId);
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session?.socket) return;
    session.cancelled = true;
    session.done = true;
    // Settle BEFORE touching the socket, for the same reason terminate() does (see issue #55):
    // the 'close' and 'error' handlers settle the exit as SIGPIPE/failed, and `write` on a
    // socket that is already broken can fire 'error' synchronously. Settling afterwards then
    // loses the race and reports 'failed' for what was a deliberate cancellation.
    //
    // The abort frame is still sent -- settleExit only resolves a promise, it does not close
    // anything -- so the daemon still learns the run was cancelled rather than dropped.
    settleExit(session, { code: 130, signal: 'SIGTERM', reason: 'cancelled' });
    session.socket.write(frame({ type: 'abort' }));
    session.socket.destroy();
    session.proc?.kill('SIGTERM');
  }

  async resume(runId: string, _context?: RunContext): Promise<AgentHandle> {
    // Daemon sessions are resident; a new start() with the same runId re-attaches.
    // Resume is not supported: the worker falls back to start().
    throw new Error('DaemonAgentAdapter does not support resume; use start()');
  }
}

function frame(obj: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`daemon socket not ready: ${path}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (buffer.length >= 4 + len) {
          socket.off('data', onData);
          resolve(buffer.subarray(4, 4 + len));
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}


