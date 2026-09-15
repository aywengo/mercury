// ClaudeCodeAdapter: drives Anthropic's Claude Code CLI in non-interactive print mode
// (Mercury docs/agent-adapters.md section 3, Phase 2).
//
// VERIFIED AGAINST claude 1.0.3, not against the design doc. The doc's Phase 2 table was written
// against a different Claude Code release and five of the flags it names do not exist in 1.0.3:
//
//   --input-format             ABSENT  -> sendInput() is not possible; see below
//   --session-id               ABSENT  -> session id is read from the stream instead
//   --permission-mode          ABSENT  -> --dangerously-skip-permissions is the only knob
//   --include-partial-messages ABSENT  -> no `stream_event` deltas, so no partial agent.message
//   --max-turns                ABSENT  -> turn budget cannot be set from here
//
// Two further behaviours the doc does not mention, both observed:
//
//   1. `-p --output-format stream-json` FAILS OUTRIGHT unless --verbose is also passed:
//        "Error: When using --print, --output-format=stream-json requires --verbose"
//      --verbose is therefore always added. It is not optional and not a debug nicety.
//   2. A failed run reports `"subtype":"success"` together with `"is_error":true` and exits 1.
//      Mapping `result` -> run.completed on subtype alone would mark failures as completed, so
//      is_error is authoritative and the exit code is checked as well.
//
// Verified event shapes (captured from the real CLI):
//   {"type":"system","subtype":"init","session_id":"<uuid>","tools":[...],"mcp_servers":[...]}
//   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}
//   {"type":"result","subtype":"success","is_error":bool,"result":"...","num_turns":N,"session_id":"..."}
//
// tool_use / tool_result blocks are mapped from the documented content-block shape. They were NOT
// observable locally (no usable API key, so no tool ever ran); the mock fixture exercises that path
// instead. Stated here rather than implied by a green test suite.
//
// Task text goes to STDIN, never argv: `-p` with no positional prompt reads stdin (verified), which
// sidesteps ARG_MAX for long tasks and keeps run tasks out of every `ps` on the host.
//
// sendInput() throws. Without --input-format there is no way to write to a running `claude -p`, and
// pretending otherwise would advertise a capability this adapter cannot honour -- the exact defect
// #194 was filed for. HermesAgentAdapter sets the precedent for a documented throw.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExitGate, rearmExitGate, settleExit } from './exitSettlement.ts';
import { isRecord } from './eventTranslation.ts';
import { CLAUDE_MD_FILE, NOTES_FILE, containedPath } from '../knowledge/materialize.ts';
import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext, AgentCapabilities } from '../domain/types.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';

export interface ClaudeCodeAdapterOptions {
  /** claude binary (default "claude"). */
  cmd?: string;
  /** extra static args inserted before the adapter's own flags (test wrappers). */
  args?: string[];
  sandbox?: SandboxManager;
  workerId?: string;
  /** --model <alias|name> (default: leave unset = claude's own default). */
  model?: string;
  /** --allowedTools <tools>. Claude 1.0.3 syntax is `Bash(git:*) Edit`, not `Bash(git *)`. */
  allowedTools?: string;
  /** --disallowedTools <tools>. */
  disallowedTools?: string;
  /** --mcp-config <file or json string>. */
  mcpConfig?: string;
  /**
   * --dangerously-skip-permissions. Off by default and deliberately opt-in: the CLI help says it
   * "only works in Docker containers with no internet access", so it is a sandbox-only knob and
   * silently enabling it for every run would be wrong twice over.
   */
  skipPermissions?: boolean;
  /** cancel grace period before SIGKILL (default 5000ms). */
  cancelGraceMs?: number;
  /** how long to wait after exit for stdout to drain (default 5000ms; see issue #166). */
  drainGraceMs?: number;
  /** extra env for the spawned process (test knobs). */
  env?: Record<string, string>;
}

interface Session {
  runId: string;
  proc: ChildProcessWithoutNullStreams | null;
  done: boolean;
  cancelled: boolean;
  terminated: boolean;
  queue: AgentEvent[];
  waiters: ((ev: AgentEvent) => void)[];
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
  /** Provided by the createExitGate() spread; declared so the shared helpers accept this type. */
  exitSettled: boolean;
  /**
   * Session id from the most recent `system`/init event. Refreshed on EVERY spawn, including
   * resume: verified against claude 1.0.3, resuming session X emits a NEW session id Y, so keeping
   * X would make a second resume target a stale id.
   */
  sessionId: string | null;
  /**
   * tool_use.id -> tool name. `tool_result` blocks carry only `tool_use_id`, never the name, so
   * without this map tool.completed/tool.failed would lose which tool finished.
   */
  toolNames: Map<string, string>;
  /** true once any assistant text has been emitted; guards against re-sending result.result. */
  emittedText: boolean;
  /** stderr tail, kept only to explain a failure; bounded so a chatty CLI cannot grow it forever. */
  errTail: string;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  stdoutEnded: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
  /** set when the `result` event said is_error, which outranks subtype and the exit code. */
  resultIsError: boolean;
  /**
   * True when a pack exists but `CLAUDE.md` was already there, so the pack could not be written into
   * the channel Claude Code reads and goes into the stdin task text instead (section 9.3).
   */
  knowledgeDegraded: boolean;
  context: RunContext;
}

/**
 * True when something is AT the path, without following it.
 *
 * Mirrors the identical guard in HermesAgentAdapter, and for the same reason: `existsSync` reports a
 * dangling symlink as absent, and `writeFileSync` then follows it. A repository that tracks `CLAUDE.md`
 * as a symlink pointing outside the workspace would have Mercury's pack written to that target -- the
 * escape `containedPath` already blocks for the neutral files, reachable here by a different route.
 * Anything already at the path is left alone, symlink or not: section 9.4 forbids editing a tracked file.
 */
/**
 * The workspace context pointer. Declared here as it already is in the prime-agent, rpc and daemon
 * adapters -- four copies of a filename is untidy, but consolidating it is a separate change from
 * adding a knowledge channel, and this constant is load-bearing in exactly one way: it must match what
 * the worker writes, or the pointer line names a file that does not exist.
 */
const CONTEXT_FILE = '.mercury-context.json';

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text handed to `claude -p` on stdin.
 *
 * Normally the run task verbatim. When a pack exists but CLAUDE.md was tracked and so left alone,
 * section 9.3 prescribes the fallback of pointing at the context file from the prompt, because the
 * prompt is the only remaining channel that reaches the model. Appended rather than prepended so the
 * task still opens as its author wrote it.
 */
function taskText(session: Session): string {
  const task = session.context.run.task;
  if (!session.knowledgeDegraded) return `${task}\n`;
  return `${task}\n\n(Project knowledge for this task is in ${CONTEXT_FILE} under "knowledge", and in ${NOTES_FILE}.)\n`;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };
const DEFAULT_DRAIN_GRACE_MS = 5000;
const MAX_ERR_TAIL = 4000;

export class ClaudeCodeAdapter implements AgentAdapter {
  /** Claude Code exposes no goal surface: `claude --help` has no goal flag on either
   *  install measured (1.0.3 and 2.1.260), and the adapter emits no goal argv. */
  readonly capabilities: AgentCapabilities = {
    static: {
      // Measured: this adapter references no skill at all. Mercury still writes the workspace
      // snapshot, but nothing here tells Claude Code to read it, so 'none' is the honest value --
      // 'workspacePaths' would advertise a capability nobody implemented.
      skills: 'none',
    },
  };
  private opts: ClaudeCodeAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.opts = opts;
  }

  /**
   * Build argv. Only flags that exist in claude 1.0.3 are emitted; --verbose is unconditional
   * because stream-json hard-fails without it.
   */
  private buildArgv(resumeId: string | null): string[] {
    const argv = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (this.opts.model) argv.push('--model', this.opts.model);
    if (this.opts.allowedTools) argv.push('--allowedTools', this.opts.allowedTools);
    if (this.opts.disallowedTools) argv.push('--disallowedTools', this.opts.disallowedTools);
    if (this.opts.mcpConfig) argv.push('--mcp-config', this.opts.mcpConfig);
    if (this.opts.skipPermissions) argv.push('--dangerously-skip-permissions');
    if (resumeId) argv.push('-r', resumeId);
    return argv;
  }

  private wrapForSandbox(ctx: RunContext, argv: string[]): { cmd: string; args: string[] } {
    const sandbox = this.opts.sandbox;
    const base = this.opts.cmd ?? 'claude';
    if (!sandbox || !sandbox.requiresSandbox(ctx.run)) return { cmd: base, args: argv };
    const runWithWs = { ...ctx.run, workspacePath: ctx.run.workspacePath ?? ctx.workspace.path };
    return sandbox.buildCommand(runWithWs, base, argv);
  }

  private newSession(runId: string, context: RunContext): Session {
    return {
      runId,
      proc: null,
      done: false,
      cancelled: false,
      terminated: false,
      queue: [],
      waiters: [],
      ...createExitGate(),
      sessionId: null,
      toolNames: new Map(),
      emittedText: false,
      errTail: '',
      exitInfo: null,
      stdoutEnded: false,
      drainTimer: null,
      resultIsError: false,
      knowledgeDegraded: false,
      context,
    };
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const session = this.newSession(runId, context);

    // The knowledge channel (docs/knowledge-base.md section 9.3).
    //
    // Claude Code reads CLAUDE.md from the working directory, so that is where the pack goes -- the
    // same shape HermesAgentAdapter uses for AGENTS.md, including the two guards that make it safe:
    // lstat rather than existsSync (a dangling symlink reports absent and writeFileSync then follows
    // it), and containedPath for the write itself (lstat follows a symlinked workspace ROOT, which the
    // first guard cannot see).
    //
    // When the repository already tracks CLAUDE.md, section 9.4 forbids touching it and the pack falls
    // back to a line in the stdin task text. That fallback is recorded on the session rather than
    // logged and forgotten, because it is the difference between the agent being told about the pack
    // and not being told, which is the whole job.
    if (context.knowledge) {
      const notesPath = join(context.workspace.path, NOTES_FILE);
      if (!lstatExists(join(context.workspace.path, CLAUDE_MD_FILE)) && existsSync(notesPath)) {
        const claudeMdPath = containedPath(context.workspace.path, CLAUDE_MD_FILE);
        writeFileSync(claudeMdPath, readFileSync(notesPath, 'utf8'));
      } else {
        session.knowledgeDegraded = true;
      }
    }

    this.sessions.set(runId, session);
    this.spawnProcess(session, this.buildArgv(null));
    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }

  private spawnProcess(session: Session, argv: string[]): void {
    const ctx = session.context;
    const fullArgs = [...(this.opts.args ?? []), ...argv];
    const spawnCmd = this.wrapForSandbox(ctx, fullArgs);
    const traceEnv: Record<string, string> = {
      MERCURY_RUN_ID: session.runId,
      MERCURY_TRACE_ID: session.runId,
    };
    if (this.opts.workerId) traceEnv.MERCURY_WORKER_ID = this.opts.workerId;

    const proc = spawn(spawnCmd.cmd, spawnCmd.args, {
      cwd: ctx.workspace.path,
      // this.opts.env last so a test knob can always win.
      env: { ...process.env, ...traceEnv, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;

    proc.on('error', () => {
      if (session.exitSettled) return;
      this.clearDrainGrace(session);
      session.done = true;
      for (const w of session.waiters.splice(0)) w(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    });

    // Record the exit but do NOT settle: stdout may still hold the final events. Node fires 'exit'
    // when the process is gone, not when stdio drained -- settling here is the issue #166 bug that
    // released consumers before the last message existed.
    proc.on('exit', (code, signal) => {
      session.exitInfo = { code, signal };
      this.armDrainGrace(session);
      this.settleWhenDrained(session);
    });

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      // Split on newline and keep the remainder: a JSONL object can straddle two chunks.
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(session, line);
      }
    });
    proc.stdout.on('end', () => {
      const rest = buf.trim();
      buf = '';
      if (rest) this.handleLine(session, rest);
      session.stdoutEnded = true;
      this.settleWhenDrained(session);
    });
    proc.on('close', () => {
      const rest = buf.trim();
      buf = '';
      if (rest) this.handleLine(session, rest);
      session.stdoutEnded = true;
      this.settleWhenDrained(session);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      session.errTail = (session.errTail + chunk.toString()).slice(-MAX_ERR_TAIL);
    });

    // Task via stdin, never argv (see header).
    proc.stdin.write(taskText(session));
    proc.stdin.end();
  }

  /**
   * Translate one stream-json line into Mercury events.
   *
   * Shapes here are the ones captured from claude 1.0.3 (see header). Anything unrecognised is
   * ignored rather than fatal: Claude Code adds stream types between releases, and a new one must
   * not break a run that is otherwise succeeding.
   */
  private handleLine(session: Session, line: string): void {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // not JSON (banner, warning): not an event, and not a failure
    }
    if (!isRecord(ev) || typeof ev.type !== 'string') return;

    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init' && typeof ev.session_id === 'string') {
          session.sessionId = ev.session_id;
        }
        push(session, {
          type: 'run.started',
          payload: {
            sessionId: session.sessionId,
            tools: Array.isArray(ev.tools) ? ev.tools : undefined,
          },
        });
        return;
      }
      case 'assistant': {
        for (const block of contentBlocks(ev.message)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text.trim();
            if (!text) continue;
            session.emittedText = true;
            push(session, { type: 'agent.message', payload: { text } });
          } else if (block.type === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : '';
            const tool = typeof block.name === 'string' ? block.name : 'unknown';
            if (id) session.toolNames.set(id, tool);
            push(session, { type: 'tool.started', payload: { tool, args: block.input ?? {} } });
          }
        }
        return;
      }
      case 'user': {
        for (const block of contentBlocks(ev.message)) {
          if (block.type !== 'tool_result') continue;
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          // tool_result carries no name; recover it from the tool_use that opened it.
          const tool = session.toolNames.get(id) ?? 'unknown';
          if (block.is_error === true) {
            push(session, { type: 'tool.failed', payload: { tool, error: summarize(block.content) } });
          } else {
            push(session, { type: 'tool.completed', payload: { tool, result: summarize(block.content) } });
          }
        }
        return;
      }
      case 'result': {
        // is_error outranks subtype. Verified: a failed run emits subtype "success" WITH
        // is_error true and exits 1, so subtype alone would mark failures as completed.
        session.resultIsError = ev.is_error === true;
        const text = typeof ev.result === 'string' ? ev.result.trim() : '';
        // result.result repeats the last assistant text. Re-emitting it would duplicate the
        // message, so it is only used when no assistant text ever arrived.
        if (text && !session.emittedText) push(session, { type: 'agent.message', payload: { text } });
        return;
      }
      default:
        return;
    }
  }

  private settleWhenDrained(session: Session): void {
    if (session.exitSettled || !session.exitInfo || !session.stdoutEnded) return;
    this.clearDrainGrace(session);
    const { code, signal } = session.exitInfo;
    this.handleExit(session, code, signal);
  }

  private armDrainGrace(session: Session): void {
    if (session.drainTimer) return;
    const ms = this.opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = null;
      if (session.exitSettled || !session.exitInfo) return;
      const { code, signal } = session.exitInfo;
      this.handleExit(session, code, signal);
      this.releasePipes(session);
    }, ms);
    session.drainTimer.unref?.();
  }

  private releasePipes(session: Session): void {
    const proc = session.proc;
    if (!proc) return;
    proc.stdout.removeAllListeners('data');
    proc.stdout.removeAllListeners('end');
    proc.stderr.removeAllListeners('data');
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.stdout.destroy();
    proc.stderr.destroy();
  }

  private clearDrainGrace(session: Session): void {
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
  }

  private finish(session: Session, exit: AgentExit): void {
    session.done = true;
    for (const w of session.waiters.splice(0)) w(DONE);
    settleExit(session, exit);
  }

  private handleExit(session: Session, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.exitSettled) return;
    this.clearDrainGrace(session);
    if (session.cancelled) return this.finish(session, { code, signal, reason: 'cancelled' });
    if (session.terminated) return this.finish(session, { code, signal, reason: 'terminated' });
    // Two independent failure signals, either of which is sufficient. The CLI exits 0 in some
    // error paths and exits 1 with subtype "success" in others, so neither alone is enough.
    if (session.resultIsError || code !== 0) {
      const detail = session.errTail.trim().slice(-500);
      return this.finish(session, {
        code,
        signal,
        reason: 'failed',
        ...(detail ? { message: `claude failed: ${detail}` } : {}),
      });
    }
    this.finish(session, { code, signal, reason: 'completed' });
  }

  /**
   * Not supported by claude 1.0.3, and deliberately a loud error rather than a silent no-op.
   *
   * `claude -p` has no --input-format in this version, so there is no channel to write to once the
   * process is running. Accepting input and dropping it would advertise a capability the adapter
   * cannot honour -- the defect #194 was filed for -- and would leave the run waiting on an
   * input.required that can never be answered.
   */
  async sendInput(_runId: string, _input: AgentInput): Promise<void> {
    throw new Error(
      'ClaudeCodeAdapter does not support sendInput: claude 1.0.3 has no --input-format, so a '
      + 'running `claude -p` process cannot be written to. Run the follow-up as a new Run, '
      + 'or resume the session, instead.',
    );
  }

  /** Prune per-run state. The worker calls this only after terminate() resolved; see AgentAdapter. */
  dispose(runId: string): void {
    this.sessions.delete(runId);
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.cancelled || session.exitSettled) return;
    session.cancelled = true;
    this.clearDrainGrace(session);
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
    this.finish(session, { code: null, signal: 'SIGTERM', reason: 'cancelled' });
  }

  async terminate(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.terminated || session.exitSettled) return;
    session.terminated = true;
    this.clearDrainGrace(session);
    const proc = session.proc;
    if (proc && proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.finish(session, { code: null, signal: 'SIGKILL', reason: 'terminated' });
  }

  /** Resume with -r <session id> captured from the stream. */
  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    let session = this.sessions.get(runId);
    if (!session) {
      if (!context) throw new Error(`No session state for run ${runId}; resume requires a run context`);
      session = this.newSession(runId, context);
      this.sessions.set(runId, session);
    }
    if (!session.sessionId) throw new Error(`No session id for run ${runId}; use retry-from-scratch`);
    session.done = false;
    session.cancelled = false;
    session.terminated = false;
    rearmExitGate(session);
    this.spawnProcess(session, this.buildArgv(session.sessionId));
    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }
}

// --- helpers ----------------------------------------------------------------

/** Content blocks of a message object, tolerating a string content or a missing message. */
function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (Array.isArray(content)) return content.filter(isRecord);
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
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
