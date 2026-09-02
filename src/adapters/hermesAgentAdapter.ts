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
import { createExitGate, rearmExitGate, settleExit } from './exitSettlement.ts';
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
  /**
   * How long to wait after the child exits for stdout to finish draining (default 5000ms). Only
   * reachable when something other than the child keeps the pipe open; see issue #166.
   */
  drainGraceMs?: number;
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
  /**
   * Exit info as reported by the child's 'exit' event, kept until stdout has drained.
   * Node does not promise that stdio has finished when 'exit' fires -- that guarantee belongs to
   * 'close' -- so settling on 'exit' alone can release consumers before the final message exists.
   * See issue #166.
   */
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** stdout reached 'end' (or was force-drained), so the final response has been pushed. */
  stdoutEnded: boolean;
  /** true once the final response has been pushed, so the flush cannot run twice. */
  stdoutFlushed: boolean;
  /** bounded fallback so a grandchild holding stdout open cannot wedge the run forever. */
  drainTimer: ReturnType<typeof setTimeout> | null;
  /** original RunContext (needed to rebuild argv on resume) */
  context: RunContext;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };
const DEFAULT_DRAIN_GRACE_MS = 5000;
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
      queue: [],
      waiters: [],
        ...createExitGate(),
      sessionId: null,
      stdoutBuf: '',
      exitInfo: null,
      stdoutEnded: false,
      stdoutFlushed: false,
      drainTimer: null,
      context,
    };
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
      this.clearDrainGrace(session);
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    });

    proc.on('exit', (code, signal) => {
      // Record the exit, but do NOT settle yet: stdout can still be holding the final response.
      // Node fires 'exit' when the process is gone, not when its stdio has drained, and under a busy
      // event loop 'exit' reliably wins that race (issue #166). Settling here released consumers before
      // the message existed, so a run could report `completed` with zero events delivered.
      session.exitInfo = { code, signal };
      this.armDrainGrace(session);
      this.settleWhenDrained(session);
    });

    // stdout: the final response (quiet mode guarantees only this)
    proc.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuf += chunk.toString();
    });
    proc.stdout.on('end', () => {
      session.stdoutEnded = true;
      this.settleWhenDrained(session);
    });
    // 'close' is Node's guarantee that stdio is finished. If stdout was destroyed rather than ending
    // cleanly, 'end' never fires and this is the only signal that lets the run settle.
    proc.on('close', () => {
      session.stdoutEnded = true;
      this.settleWhenDrained(session);
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

  /**
   * Push the accumulated stdout as the final response, at most once.
   *
   * Called from every path that can finish the session, because the flush has to happen BEFORE any
   * waiter is released -- pushing afterwards is what lost the message in issue #166.
   */
  private flushStdout(session: Session): void {
    if (session.stdoutFlushed) return;
    session.stdoutFlushed = true;
    const text = session.stdoutBuf.trim();
    if (text) push(session, { type: 'agent.message', payload: { text } });
  }

  /**
   * Settle only once the process has exited AND stdout has been drained.
   *
   * Both halves are required. Waiting on stdout alone would hang on a child that never closes stdout;
   * settling on exit alone is the #166 bug. The grace timer bounds the second case.
   */
  private settleWhenDrained(session: Session): void {
    if (session.exitSettled || !session.exitInfo || !session.stdoutEnded) return;
    this.clearDrainGrace(session);
    this.flushStdout(session);
    const { code, signal } = session.exitInfo;
    this.handleExit(session, code, signal);
  }

  /**
   * Fallback for a child that exits but leaves stdout open -- typically a grandchild that inherited the
   * pipe. Without this the run would never settle, which is worse than a possibly truncated response.
   */
  private armDrainGrace(session: Session): void {
    if (session.drainTimer) return;
    const ms = this.opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = null;
      if (session.exitSettled || !session.exitInfo) return;
      const { code, signal } = session.exitInfo;
      this.flushStdout(session);
      this.handleExit(session, code, signal);
    }, ms);
    session.drainTimer.unref?.();
  }

  private clearDrainGrace(session: Session): void {
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
  }

  private handleExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.exitSettled) return;
    this.clearDrainGrace(session);
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
    if (!session || session.cancelled || session.exitSettled) return;
    session.cancelled = true;
    this.clearDrainGrace(session);
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
    this.clearDrainGrace(session);
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
        queue: [],
        waiters: [],
        ...createExitGate(),
        sessionId: null,
        stdoutBuf: '',
        exitInfo: null,
        stdoutEnded: false,
        stdoutFlushed: false,
        drainTimer: null,
        context,
      };
      this.sessions.set(runId, session);
    }
    if (!session.sessionId) throw new Error(`No session id for run ${runId}; use retry-from-scratch`);
    session.done = false;
    session.cancelled = false;
    session.terminated = false;
    rearmExitGate(session);
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
