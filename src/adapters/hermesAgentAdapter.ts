// HermesAgentAdapter: drives Nous Research's Hermes Agent CLI in quiet
// programmatic mode (Mercury docs/agent-adapters.md section 3, Phase 3).
//
// Verified interface (hermes v0.20.5):
//   hermes chat -Q --query-file -            # quiet, task via stdin (safe)
//   hermes chat --resume <SESSION_ID>        # resume a session
//   hermes chat --max-turns <n>              # turn budget
//   hermes chat --run-budget <seconds>       # wall-clock budget
//   hermes chat -s <skill>                   # preload skills (repeatable)
//   hermes chat --in <dir>                   # working directory
//   hermes chat --yolo / --accept-hooks      # skip approvals
//
// Output contract (verified in cli.py):
//   stdout: ONLY the final response (quiet mode neutralizes tool callbacks)
//   stderr: "session_id: <id>" printed on exit (success/failure/interrupt)
//   exit 0 = success; non-zero = failure
//
// Fidelity is text-level: final response -> agent.message, session id captured
// for resume, exit code -> completed/failed. Human input (--yolo/--accept-hooks)
// is deferred per the design.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext,
} from '../domain/types.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';

export interface HermesAgentAdapterOptions {
  /** hermes binary (default "hermes"). */
  cmd?: string;
  /** extra static args appended after the fixed ones. */
  args?: string[];
  sandbox?: SandboxManager;
  workerId?: string;
  /** --max-turns N (default: leave unset = hermes default). */
  maxTurns?: number;
  /** --run-budget SECONDS (default: leave unset = off). */
  runBudgetSeconds?: number;
  /** --yolo: bypass dangerous command approval prompts. */
  yolo?: boolean;
  /** --accept-hooks: auto-approve shell hooks. */
  acceptHooks?: boolean;
  /** --source tag for third-party integrations (default "tool"). */
  source?: string;
  /** cancel grace period before SIGKILL (default 5000ms). */
  cancelGraceMs?: number;
  /** extra env vars for the spawned process (e.g. test knobs). */
  env?: Record<string, string>;
}

interface Session {
  runId: string;
  proc: ChildProcessWithoutNullStreams | null;
  done: boolean;
  cancelled: boolean;
  terminated: boolean;
  exitSettled: boolean;
  queue: AgentEvent[];
  waiters: ((ev: AgentEvent) => void)[];
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
  sessionId: string | null;
  /** accumulated stdout (final response) */
  stdoutBuf: string;
  /** original RunContext (needed to rebuild argv on resume) */
  context: RunContext;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };
const SESSION_ID_RE = /session_id:\s*(\S+)/;

export class HermesAgentAdapter implements AgentAdapter {
  private opts: HermesAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(opts: HermesAgentAdapterOptions = {}) {
    this.opts = opts;
  }

  private buildArgv(context: RunContext, resumeId: string | null): string[] {
    const argv = ['chat', '-Q', '--query-file', '-'];
    if (resumeId) argv.push('--resume', resumeId);
    if (this.opts.maxTurns !== undefined) argv.push('--max-turns', String(this.opts.maxTurns));
    if (this.opts.runBudgetSeconds !== undefined) argv.push('--run-budget', String(this.opts.runBudgetSeconds));
    for (const skill of context.skills) {
      argv.push('-s', skill.id);
    }
    if (this.opts.yolo) argv.push('--yolo');
    if (this.opts.acceptHooks) argv.push('--accept-hooks');
    if (this.opts.source) argv.push('--source', this.opts.source);
    argv.push('--in', context.workspace.path);
    return argv;
  }

  private wrapForSandbox(run: RunContext, argv: string[]): { cmd: string; args: string[] } {
    const sandbox = this.opts.sandbox;
    if (!sandbox || !sandbox.requiresSandbox(run.run)) return { cmd: this.opts.cmd ?? 'hermes', args: argv };
    const runWithWs = { ...run.run, workspacePath: run.run.workspacePath ?? run.workspace.path };
    return sandbox.buildCommand(runWithWs, this.opts.cmd ?? 'hermes', argv);
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const session: Session = {
      runId,
      proc: null,
      done: false,
      cancelled: false,
      terminated: false,
      exitSettled: false,
      queue: [],
      waiters: [],
      exitPromise: undefined as unknown as Promise<AgentExit>,
      exitResolve: undefined as unknown as (exit: AgentExit) => void,
      sessionId: null,
      stdoutBuf: '',
      context,
    };
    session.exitPromise = new Promise<AgentExit>((resolve) => {
      session.exitResolve = resolve;
    });
    this.sessions.set(runId, session);

    const argv = this.buildArgv(context, null);
    this.spawnProcess(session, context, argv);
    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }

  private spawnProcess(session: Session, context: RunContext, argv: string[]): void {
    // opts.args (e.g. a wrapper script in tests) come right after the command
    const fullArgs = [...(this.opts.args ?? []), ...argv];
    const spawnCmd = this.wrapForSandbox(context, fullArgs);
    const traceEnv: Record<string, string> = {
      MERCURY_RUN_ID: session.runId,
      MERCURY_TRACE_ID: session.runId,
    };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;

    const proc = spawn(spawnCmd.cmd, spawnCmd.args, {
      cwd: context.workspace.path,
      env: { ...process.env, ...traceEnv, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;

    proc.on('error', (err) => {
      if (session.exitSettled) return;
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    });

    proc.on('exit', (code, signal) => {
      this.handleExit(session, code, signal);
    });

    // stdout: the final response (quiet mode guarantees only this)
    proc.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuf += chunk.toString();
    });
    proc.stdout.on('end', () => {
      const text = session.stdoutBuf.trim();
      if (text) push(session, { type: 'agent.message', payload: { text } });
    });

    // stderr: capture "session_id: <id>" for resume; ignore the rest
    let errBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      errBuf += chunk.toString();
      const m = errBuf.match(SESSION_ID_RE);
      if (m) session.sessionId = m[1];
    });

    // task via stdin (--query-file -)
    proc.stdin.write(context.run.task + '\n');
    proc.stdin.end();
  }

  private handleExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.exitSettled) return;
    if (session.cancelled) {
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code, signal, reason: 'cancelled' });
      return;
    }
    if (session.terminated) {
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code, signal, reason: 'terminated' });
      return;
    }
    session.done = true;
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code, signal, reason: code === 0 ? 'completed' : 'failed' });
  }

  /** Human input is deferred per the design (--yolo/--accept-hooks cover approvals). */
  async sendInput(_runId: string, _input: AgentInput): Promise<void> {
    throw new Error('HermesAgentAdapter does not support sendInput (deferred per design)');
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.cancelled || session.exitSettled) return;
    session.cancelled = true;
    session.done = true;
    const proc = session.proc;
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      const graceMs = this.opts.cancelGraceMs ?? 5000;
      setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, graceMs).unref?.();
    }
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: 'SIGTERM', reason: 'cancelled' });
  }

  async terminate(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.terminated || session.exitSettled) return;
    session.terminated = true;
    session.done = true;
    const proc = session.proc;
    if (proc && proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: 'SIGKILL', reason: 'terminated' });
  }

  /** Resume a session: respawn with --resume <sessionId> captured from stderr. */
  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    let session = this.sessions.get(runId);
    if (!session) {
      if (!context) throw new Error(`No session state for run ${runId}; resume requires a run context`);
      session = {
        runId,
        proc: null,
        done: false,
        cancelled: false,
        terminated: false,
        exitSettled: false,
        queue: [],
        waiters: [],
        exitPromise: undefined as unknown as Promise<AgentExit>,
        exitResolve: undefined as unknown as (exit: AgentExit) => void,
        sessionId: null,
        stdoutBuf: '',
        context,
      };
      session.exitPromise = new Promise<AgentExit>((resolve) => {
        session!.exitResolve = resolve;
      });
      this.sessions.set(runId, session);
    }
    if (!session.sessionId) throw new Error(`No session id for run ${runId}; use retry-from-scratch`);
    session.done = false;
    session.cancelled = false;
    session.terminated = false;
    session.exitSettled = false;
    session.exitPromise = new Promise<AgentExit>((resolve) => {
      session.exitResolve = resolve;
    });
    session.stdoutBuf = '';
    const argv = this.buildArgv(session.context, session.sessionId);
    this.spawnProcess(session, session.context, argv);

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }
}

// --- helpers ----------------------------------------------------------------

function settleExit(session: Session, exit: AgentExit): void {
  if (session.exitSettled) return;
  session.exitSettled = true;
  session.exitResolve(exit);
}

function push(session: Session, ev: AgentEvent): void {
  const waiter = session.waiters.shift();
  if (waiter) waiter(ev);
  else session.queue.push(ev);
}

function eventsGenerator(session: Session): AsyncGenerator<AgentEvent> {
  return (async function* () {
    while (true) {
      if (session.queue.length > 0) {
        yield session.queue.shift()!;
      } else if (session.done) {
        return;
      } else {
        const ev = await new Promise<AgentEvent>((resolve) => session.waiters.push(resolve));
        if (ev === DONE) {
          while (session.queue.length > 0) yield session.queue.shift()!;
          return;
        }
        yield ev;
      }
    }
  })();
}
