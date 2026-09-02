// LocalAgentAdapter: generic adapter for any local CLI agent that can run
// non-interactively (Mercury docs/agent-adapters.md section 4).
//
// Everything is declarative config: how to spawn, how the task is passed,
// how stdout is parsed, how agent events map to Mercury events, how human
// input / cancellation / resume work. No per-agent code.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExitGate, rearmExitGate, settleExit } from './exitSettlement.ts';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext,
} from '../domain/types.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';

// --- config schema (docs/agent-adapters.md section 4.1) ---------------------

export interface LocalAgentTaskInput {
  mode: 'arg' | 'stdin' | 'file';
  /** For 'arg': the flag before the task text (e.g. "--message"). For 'file': the flag before the file path. */
  flag?: string;
  /** For 'file': relative path inside the workspace where the task is written. */
  filePath?: string;
}

export interface LocalAgentOutput {
  format: 'jsonl' | 'json' | 'text';
  /** jsonl: parse line-by-line; json: single doc parsed at exit. */
  stream?: boolean;
  /** jsonl: field name holding the event type (default "type"). */
  eventPath?: string;
}

export interface LocalAgentEventMap {
  /** agent event type -> Mercury event type */
  started?: string;
  message?: string;
  toolStarted?: string;
  toolCompleted?: string;
  toolFailed?: string;
  stepStarted?: string;
  stepCompleted?: string;
  error?: string;
  /** agent event type that means "done" (resolves the run as completed). */
  completed?: string;
  /** any other agent event type can be mapped (e.g. "tool_started": "tool.started"). */
  [agentType: string]: string | undefined;
}

export interface LocalAgentInput {
  mode: 'stdin' | 'flag' | 'prompt-file';
  /** For 'flag': the flag to respawn with the answer. For 'prompt-file': relative path in workspace. */
  flag?: string;
  filePath?: string;
  /** agent event type that means "waiting for human input". */
  promptEvent?: string;
}

export interface LocalAgentCancel {
  signal: 'SIGTERM' | 'SIGINT' | 'stdin';
  /** grace period before SIGKILL. */
  graceMs: number;
}

export interface LocalAgentResume {
  flag: string;
  sessionIdSource: 'stdout' | 'file' | 'event';
  /** 'event': JSON field; 'stdout': regex with one capture group; 'file': relative path in workspace. */
  sessionIdPath?: string;
}

export interface LocalAgentSandbox {
  policyFlag?: string;
  policyValue?: string;
}

export interface LocalAgentSkills {
  /** flag repeated per selected skill, e.g. "--allowedTools". */
  flag: string;
  /** skill id -> flag value. */
  values: Record<string, string>;
}

export interface LocalAgentConfig {
  id: string;
  description: string;
  command: string;
  args?: string[];
  /** default: the Run workspace. */
  cwd?: string;
  taskInput: LocalAgentTaskInput;
  output: LocalAgentOutput;
  eventMap: LocalAgentEventMap;
  input?: LocalAgentInput;
  cancel: LocalAgentCancel;
  resume?: LocalAgentResume;
  sandbox?: LocalAgentSandbox;
  skills?: LocalAgentSkills;
  /** extra env vars for the spawned process. */
  env?: Record<string, string>;
}

export interface LocalAgentAdapterOptions {
  sandbox?: SandboxManager;
  workerId?: string;
  /**
   * How long to wait after the child exits for stdout to finish draining (default 5000ms). Only
   * reachable when something other than the child keeps the pipe open; see issue #166.
   */
  drainGraceMs?: number;
}

// --- validation -------------------------------------------------------------

export function validateLocalAgentConfig(cfg: LocalAgentConfig): void {
  const err = (msg: string): never => { throw new Error(`LocalAgentConfig "${cfg.id}": ${msg}`); };
  if (!cfg.id) err('id is required');
  if (!cfg.command) err('command is required');
  if (!cfg.taskInput || !['arg', 'stdin', 'file'].includes(cfg.taskInput.mode)) err('taskInput.mode must be arg|stdin|file');
  if (cfg.taskInput.mode === 'arg' && !cfg.taskInput.flag) err('taskInput.flag required for mode=arg');
  if (cfg.taskInput.mode === 'file' && (!cfg.taskInput.flag || !cfg.taskInput.filePath)) err('taskInput.flag and filePath required for mode=file');
  if (!cfg.output || !['jsonl', 'json', 'text'].includes(cfg.output.format)) err('output.format must be jsonl|json|text');
  if (!cfg.eventMap || typeof cfg.eventMap !== 'object') err('eventMap is required');
  if (!cfg.cancel || !['SIGTERM', 'SIGINT', 'stdin'].includes(cfg.cancel.signal)) err('cancel.signal must be SIGTERM|SIGINT|stdin');
  if (typeof cfg.cancel.graceMs !== 'number' || cfg.cancel.graceMs < 0) err('cancel.graceMs must be a non-negative number');
  if (cfg.input && !['stdin', 'flag', 'prompt-file'].includes(cfg.input.mode)) err('input.mode must be stdin|flag|prompt-file');
  if (cfg.input?.mode === 'flag' && !cfg.input.flag) err('input.flag required for mode=flag');
  if (cfg.input?.mode === 'prompt-file' && !cfg.input.filePath) err('input.filePath required for mode=prompt-file');
  if (cfg.resume && !['stdout', 'file', 'event'].includes(cfg.resume.sessionIdSource)) err('resume.sessionIdSource must be stdout|file|event');
  if (cfg.resume?.sessionIdSource === 'event' && !cfg.resume.sessionIdPath) err('resume.sessionIdPath required for sessionIdSource=event');
}

// --- session state ----------------------------------------------------------

interface Session {
  runId: string;
  config: LocalAgentConfig;
  proc: ChildProcessWithoutNullStreams | null;
  workspacePath: string;
  done: boolean;
  cancelled: boolean;
  terminated: boolean;
  exitSettled: boolean;
  queue: AgentEvent[];
  waiters: ((ev: AgentEvent) => void)[];
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
  sessionId: string | null;
  /** accumulated stdout for json/text parsing */
  stdoutBuf: string;
  /** true after the agent emitted promptEvent (used by flag-mode input) */
  waitingForInput: boolean;
  /**
   * Exit info from the child's 'exit' event, held until stdout has drained. 'exit' does not mean stdio
   * is finished -- only 'close' does -- so settling on it can release consumers before the final output
   * has been parsed. See issue #166.
   */
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** stdout reached 'end' (or the process closed), so the format-specific flush has run. */
  stdoutEnded: boolean;
  /**
   * Emits whatever the configured output format still owes: the trailing jsonl/text line, or the whole
   * json document. Assigned per format in spawnProcess and invoked exactly once, before any waiter is
   * released.
   */
  flush: (() => void) | null;
  /** bounded fallback so a grandchild holding stdout open cannot wedge the run forever. */
  drainTimer: ReturnType<typeof setTimeout> | null;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };
const DEFAULT_DRAIN_GRACE_MS = 5000;

// --- adapter ----------------------------------------------------------------

export class LocalAgentAdapter implements AgentAdapter {
  private cfg: LocalAgentConfig;
  private opts: LocalAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(cfg: LocalAgentConfig, opts: LocalAgentAdapterOptions = {}) {
    validateLocalAgentConfig(cfg);
    this.cfg = cfg;
    this.opts = opts;
  }

  get config(): LocalAgentConfig {
    return this.cfg;
  }

  /** How long to wait after exit for stdout to drain; bounds the issue #166 fallback path. */
  private get drainGraceMs(): number {
    return this.opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
  }

  /** Wrap the spawn command in a container when the run requests isolation. */
  private wrapForSandbox(run: RunContext, argv: string[]): { cmd: string; args: string[] } {
    const sandbox = this.opts.sandbox;
    if (!sandbox || !sandbox.requiresSandbox(run.run)) return { cmd: this.cfg.command, args: argv };
    const runWithWs = { ...run.run, workspacePath: run.run.workspacePath ?? run.workspace.path };
    return sandbox.buildCommand(runWithWs, this.cfg.command, argv);
  }

  /** Build argv: [command, ...args, task..., skills..., sandbox flags...]. */
  private buildArgv(context: RunContext): { argv: string[]; taskViaStdin: string | null; taskFile: string | null } {
    const cfg = this.cfg;
    const argv: string[] = [...(cfg.args ?? [])];
    let taskViaStdin: string | null = null;
    let taskFile: string | null = null;

    // task input
    switch (cfg.taskInput.mode) {
      case 'arg':
        argv.push(cfg.taskInput.flag!, context.run.task);
        break;
      case 'stdin':
        taskViaStdin = context.run.task;
        break;
      case 'file': {
        const rel = cfg.taskInput.filePath!;
        const abs = join(context.workspace.path, rel);
        writeFileSync(abs, context.run.task);
        argv.push(cfg.taskInput.flag!, rel);
        taskFile = abs;
        break;
      }
    }

    // skills -> tool flags (docs/agent-adapters.md section 6)
    if (cfg.skills) {
      for (const skill of context.skills) {
        const value = cfg.skills.values[skill.id];
        if (value) {
          argv.push(cfg.skills.flag, value);
        }
      }
    }

    // sandbox policy flags (e.g. codex --sandbox workspace-write)
    if (cfg.sandbox?.policyFlag) {
      argv.push(cfg.sandbox.policyFlag);
      if (cfg.sandbox.policyValue) argv.push(cfg.sandbox.policyValue);
    }

    return { argv, taskViaStdin, taskFile };
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;
    const { argv, taskViaStdin, taskFile } = this.buildArgv(context);

    const session: Session = {
      runId,
      config: this.cfg,
      proc: null,
      workspacePath,
      done: false,
      cancelled: false,
      terminated: false,
      queue: [],
      waiters: [],
        ...createExitGate(),
      sessionId: null,
      stdoutBuf: '',
      waitingForInput: false,
      exitInfo: null,
      stdoutEnded: false,
      flush: null,
      drainTimer: null,
    };
    this.sessions.set(runId, session);

    const spawnCmd = this.wrapForSandbox(context, argv);
    const traceEnv: Record<string, string> = {
      MERCURY_RUN_ID: runId,
      MERCURY_TRACE_ID: runId,
    };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;

    let started = false;
    try {
      this.spawnProcess(session, spawnCmd.cmd, spawnCmd.args, workspacePath, traceEnv);
      started = true;
    } catch (err) {
      // spawn failure (e.g. command not found) must fail the run, not hang it
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    }

    if (started && taskViaStdin !== null) {
      session.proc?.stdin.write(taskViaStdin + '\n');
    }

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }

  /** Spawn (or respawn) the agent process and attach the stdout parser. */
  private spawnProcess(
    session: Session,
    cmd: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ): void {
    const proc = spawn(cmd, args, {
      cwd: session.config.cwd ?? cwd,
      env: { ...process.env, ...extraEnv, ...session.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;

    proc.on('error', (err) => {
      // spawn failure (ENOENT etc.)
      if (session.exitSettled) return;
      this.clearDrainGrace(session);
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    });

    proc.on('exit', (code, signal) => {
      // Record the exit but do NOT settle yet -- stdout may still hold output to parse. Under a busy
      // event loop 'exit' reliably beats stdout's 'end', which is how issue #166 lost events.
      session.exitInfo = { code, signal };
      this.armDrainGrace(session);
      this.settleWhenDrained(session);
    });

    proc.stderr.on('data', () => {
      // stderr is not part of the domain model; ignore (could be logged later)
    });

    const fmt = session.config.output.format;
    if (fmt === 'jsonl') {
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          this.handleJsonlLine(session, line);
        }
      });
      // Only the trailing unterminated line is owed here; complete lines were already emitted.
      session.flush = () => {
        if (buf.trim()) this.handleJsonlLine(session, buf.trim());
      };
    } else if (fmt === 'json') {
      proc.stdout.on('data', (chunk: Buffer) => {
        session.stdoutBuf += chunk.toString();
      });
      // The whole document is produced here, so losing this flush loses every event the run emitted.
      session.flush = () => {
        this.handleJsonDoc(session);
      };
    } else {
      // text
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line.trim()) push(session, { type: 'agent.message', payload: { text: line } });
        }
      });
      session.flush = () => {
        if (buf.trim()) push(session, { type: 'agent.message', payload: { text: buf.trim() } });
      };
    }

    const drained = () => {
      session.stdoutEnded = true;
      this.settleWhenDrained(session);
    };
    proc.stdout.on('end', drained);
    // 'close' is Node's guarantee that stdio is finished; if stdout was destroyed rather than ending
    // cleanly, 'end' never fires and this is the only signal that lets the run settle.
    proc.on('close', drained);
  }

  /**
   * Settle only once the process has exited AND stdout has been drained and flushed.
   *
   * Both halves are required: waiting on stdout alone would hang on a child that never closes stdout,
   * and settling on exit alone is the issue #166 bug. The grace timer bounds the former.
   */
  private settleWhenDrained(session: Session): void {
    if (session.exitSettled || !session.exitInfo || !session.stdoutEnded) return;
    this.clearDrainGrace(session);
    const flush = session.flush;
    session.flush = null; // run at most once, even if 'end' and 'close' both arrive
    if (flush) flush();
    const { code, signal } = session.exitInfo;
    this.handleExit(session, code, signal);
  }

  /**
   * Fallback for a child that exits but leaves stdout open -- typically a grandchild that inherited the
   * pipe. Without this the run never settles, which is worse than a possibly truncated result.
   */
  private armDrainGrace(session: Session): void {
    if (session.drainTimer) return;
    const ms = this.drainGraceMs;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = null;
      if (session.exitSettled || !session.exitInfo) return;
      const flush = session.flush;
      session.flush = null;
      if (flush) flush();
      const { code, signal } = session.exitInfo;
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

  private handleJsonlLine(session: Session, line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON line in jsonl mode: ignore
    }
    const eventPath = session.config.output.eventPath ?? 'type';
    const agentType = typeof obj[eventPath] === 'string' ? (obj[eventPath] as string) : null;
    if (agentType === null) return;
    this.handleAgentEvent(session, agentType, obj);
  }

  private handleJsonDoc(session: Session): void {
    const cfg = session.config;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(session.stdoutBuf) as Record<string, unknown>;
    } catch {
      return;
    }
    const map = cfg.eventMap;
    // doc fields are the agent events: emit mapped fields first
    for (const [agentType, hermesType] of Object.entries(map)) {
      if (agentType === 'completed' || !hermesType) continue;
      if (doc[agentType] !== undefined) {
        const value = doc[agentType];
        const payload = hermesType === 'agent.message' && typeof value === 'string'
          ? { text: value }
          : value;
        push(session, { type: hermesType, payload });
      }
    }
    // done marker present -> complete
    if (map.completed && doc[map.completed] !== undefined) {
      finishCompleted(session);
    }
  }

  private handleAgentEvent(session: Session, agentType: string, payload: Record<string, unknown>): void {
    const cfg = session.config;
    const map = cfg.eventMap;

    // session id capture (resume.sessionIdSource=event)
    if (cfg.resume?.sessionIdSource === 'event' && cfg.resume.sessionIdPath) {
      const v = payload[cfg.resume.sessionIdPath];
      if (typeof v === 'string') session.sessionId = v;
    }

    // human input prompt
    if (cfg.input?.promptEvent && agentType === cfg.input.promptEvent) {
      session.waitingForInput = true;
      push(session, { type: 'input.required', payload });
      return;
    }

    // completion marker
    if (map.completed && agentType === map.completed) {
      finishCompleted(session);
      return;
    }

    // generic mapping
    const hermesType = map[agentType as keyof LocalAgentEventMap];
    if (typeof hermesType === 'string') {
      push(session, { type: hermesType, payload });
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
    // flag-mode input: the agent may exit while waiting for the answer; keep the
    // session alive so sendInput() can respawn with the answer flag.
    if (session.config.input?.mode === 'flag' && session.waitingForInput) {
      return; // wait for sendInput to respawn
    }
    session.done = true;
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code, signal, reason: code === 0 ? 'completed' : 'failed' });
  }

  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) throw new Error(`No live agent session for run ${runId}`);
    const mode = session.config.input?.mode ?? 'stdin';
    const value = input.value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);

    if (mode === 'stdin') {
      if (!session.proc || session.proc.exitCode !== null) throw new Error(`Agent process for run ${runId} is not running`);
      session.proc.stdin.write(text + '\n');
      return;
    }

    if (mode === 'prompt-file') {
      const rel = session.config.input!.filePath!;
      writeFileSync(join(session.workspacePath, rel), text);
      if (session.proc && session.proc.exitCode === null) {
        session.proc.stdin.write('\n'); // wake the agent
      }
      return;
    }

    // mode === 'flag': respawn with the answer as a flag. The agent asked and is
    // about to exit (or already has); wait for the exit before respawning so the
    // answer is not lost. Bounded wait; on timeout fall back to stdin.
    if (session.proc && session.proc.exitCode === null) {
      const proc = session.proc;
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        proc.stdin.write(text + '\n');
        return;
      }
    }
    const flag = session.config.input!.flag!;
    const argv = [...(session.config.args ?? []), flag, text];
    session.waitingForInput = false;
    const traceEnv: Record<string, string> = { MERCURY_RUN_ID: runId, MERCURY_TRACE_ID: runId };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;
    this.spawnProcess(session, session.config.command, argv, session.workspacePath, traceEnv);
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
      const cfg = session.config.cancel;
      if (cfg.signal === 'stdin') {
        try { proc.stdin.write('\u0003'); } catch { /* ignore */ }
      } else {
        proc.kill(cfg.signal);
      }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, cfg.graceMs).unref?.();
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

  /** Resume a Run from its captured session id (docs/agent-adapters.md section 4.2). */
  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    let session = this.sessions.get(runId);
    if (!session) {
      if (!context) throw new Error(`No session state for run ${runId}; resume requires a run context`);
      const workspacePath = context.workspace.path;
      session = {
        runId,
        config: this.cfg,
        proc: null,
        workspacePath,
        done: false,
        cancelled: false,
        terminated: false,
        queue: [],
        waiters: [],
        ...createExitGate(),
        sessionId: null,
        stdoutBuf: '',
        waitingForInput: false,
        exitInfo: null,
        stdoutEnded: false,
        flush: null,
        drainTimer: null,
      };
      this.sessions.set(runId, session);
    }
    const cfg = session.config.resume;
    if (!cfg) throw new Error(`Agent ${session.config.id} does not support resume`);

    let sessionId = session.sessionId;
    if (!sessionId && cfg.sessionIdSource === 'file' && cfg.sessionIdPath) {
      try {
        const { readFileSync } = await import('node:fs');
        sessionId = readFileSync(join(session.workspacePath, cfg.sessionIdPath), 'utf8').trim() || null;
      } catch { /* no file yet */ }
    }
    if (!sessionId) throw new Error(`No session id for run ${runId}; use retry-from-scratch`);

    session.done = false;
    session.cancelled = false;
    session.terminated = false;
    rearmExitGate(session);

    const argv = [...(session.config.args ?? []), cfg.flag, sessionId];
    const traceEnv: Record<string, string> = { MERCURY_RUN_ID: runId, MERCURY_TRACE_ID: runId };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;
    this.spawnProcess(session, session.config.command, argv, session.workspacePath, traceEnv);

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }
}

// --- helpers ----------------------------------------------------------------

function finishCompleted(session: Session): void {
  if (session.exitSettled) return;
  session.done = true;
  for (const waiter of session.waiters.splice(0)) waiter(DONE);
  settleExit(session, { code: 0, signal: null, reason: 'completed' });
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
