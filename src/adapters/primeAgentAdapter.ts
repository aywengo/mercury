// PrimeAgentAdapter: real PrimeAgent integration via RPC mode.
// (Mercury.md sections 8, 31 "PrimeAgent Integration".)
//
// PrimeAgent exposes a language-agnostic programmatic interface: `prime-agent
// --mode rpc` — strict JSONL commands on stdin, responses + events on stdout.
// This adapter spawns that process per Run, translates RPC events into Mercury
// domain events, and bridges human-in-the-loop dialogs (extension_ui_request /
// extension_ui_response) to Mercury' NEEDS_INPUT flow.
//
// Event mapping (RPC -> Mercury):
//   message_update (text_delta)  -> accumulated; emitted as agent.message on message_end
//   tool_execution_start         -> tool.started
//   tool_execution_end           -> tool.completed | tool.failed
//   extension_ui_request (dialog)-> input.required (select/confirm/input/editor)
//   agent_end                    -> run completion (exit code 0)
//   compaction_* / auto_retry_*  -> agent.message (informational)
//
// Sessions are persisted per Run under <workspace>/.mercury-sessions/ so a Run
// can be resumed (Mercury.md section 16) via `--resume <sessionFile>`.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, Run, RunConstraints, RunContext,
} from '../domain/types.ts';
import { RpcClient, type RpcEvent } from './rpc/rpcClient.ts';
import { EventTranslator } from './eventTranslation.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';

const SESSION_DIR_NAME = '.mercury-sessions';
const SESSION_PATH_FILE = '.mercury-session-path';
const CONTEXT_FILE = '.mercury-context.json';
const OUTPUT_LOG = 'agent-output.log';

export interface PrimeAgentAdapterOptions {
  /** Extra CLI args passed to prime-agent after --mode rpc (e.g. --provider, --model). */
  args?: string[];
  /** Session directory name inside the workspace. */
  sessionDirName?: string;
  /** Optional sandbox manager; when set and the run requests isolation, the agent
   *  process runs inside a container with the run's resource/network limits. */
  sandbox?: SandboxManager;
  /** Owning worker id; propagated to the agent process for log correlation (section 25). */
  workerId?: string;
}

/** Trace context exported to the agent process (Mercury.md section 25: the Run ID
 *  is the trace ID; worker id correlates worker logs). */
function mercuryTraceEnv(runId: string, workerId?: string): Record<string, string> {
  const env: Record<string, string> = { MERCURY_RUN_ID: runId, MERCURY_TRACE_ID: runId };
  if (workerId) env.MERCURY_WORKER_ID = workerId;
  return env;
}

interface Session {
  runId: string;
  run: Run;
  constraints: RunConstraints;
  client: RpcClient | null;
  workspacePath: string;
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

export class PrimeAgentAdapter implements AgentAdapter {
  private cmd: string;
  private opts: PrimeAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(cmd: string, opts: PrimeAgentAdapterOptions = {}) {
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

  /** Create (and register) a session for a run. Shared by start() and resume(). */
  private createSession(context: RunContext): Session {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;
    const session: Session = {
      runId,
      run: context.run,
      constraints: context.constraints,
      client: null,
      workspacePath,
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
    return session;
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;

    // Run context file the task prompt points the agent at.
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

    const session = this.createSession(context);

    const skillArgs: string[] = [];
    for (const skill of context.skills) {
      skillArgs.push('--skill', join(workspacePath, '.agents', 'skills', skill.id));
    }

    const spawnCmd = this.wrapForSandbox(context, [
      '--mode', 'rpc',
      '--cwd', workspacePath,
      '--session-dir', sessionDir,
      ...skillArgs,
      ...(this.opts.args ?? []),
    ]);
    const client = new RpcClient({
      cmd: spawnCmd.cmd,
      args: spawnCmd.args,
      cwd: workspacePath,
      env: mercuryTraceEnv(runId, this.opts.workerId),
      onStderr: (chunk) => {
        try {
          appendFileSync(join(workspacePath, OUTPUT_LOG), chunk);
        } catch {
          // best effort
        }
      },
    });
    session.client = client;

    client.onEvent((ev) => {
      for (const translated of this.translate(session, ev)) {
        push(session, translated);
        if (translated.type === 'agent.end' && !session.exitSettled) {
          // Agent finished; resolve the exit promise (the RPC process may stay alive).
          session.done = true;
          session.exitSettled = true;
          const code = (translated.payload as { code?: number }).code ?? 0;
          session.exitResolve({ code, signal: null, reason: code === 0 ? 'completed' : 'failed' });
        }
      }
    });
    client.onExit((code, signal) => {
      if (session.done) return;
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code, signal, reason: 'failed' });
    });

    let started = false;
    try {
      await client.start();
      started = true;
    } catch (err) {
      // spawn failure (e.g. command not found) must fail the run, not hang it
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code: 127, signal: null, reason: 'failed' });
    }

    if (started) {
      // Record the persisted session file for resume (Mercury.md section 16).
      try {
        const state = await client.getState();
        if (state.success && typeof state.data?.sessionFile === 'string') {
          session.sessionFile = state.data.sessionFile;
          writeFileSync(join(workspacePath, SESSION_PATH_FILE), state.data.sessionFile);
        }
      } catch {
        // non-fatal: resume falls back to retry-from-scratch
      }

      try {
        await client.prompt(buildPrompt(context));
      } catch (err) {
        session.done = true;
        for (const waiter of session.waiters.splice(0)) waiter(DONE);
        settleExit(session, { code: 1, signal: null, reason: 'failed' });
      }
    }

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }

  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || !session.client) throw new Error(`No live agent session for run ${runId}`);
    const pending = session.translator.pending;
    if (!pending) throw new Error(`Run ${runId} is not waiting for input`);
    const { requestId, method } = pending;
    session.translator.clearPending();
    const value = input.value;
    let response: Record<string, unknown>;
    if (isRecord(value) && value.cancelled === true) {
      response = { id: requestId, cancelled: true };
    } else if (method === 'confirm') {
      response = { id: requestId, confirmed: value === true || value === 'true' || value === 'yes' || value === 'y' };
    } else {
      response = { id: requestId, value };
    }
    session.client.sendExtensionUiResponse(response);
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.cancelled) return;
    session.cancelled = true;
    session.done = true; // onExit must not resolve with 'failed' while we stop
    try {
      await session.client?.abort();
    } catch {
      // process may already be gone
    }
    await session.client?.stop();
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: 'SIGTERM', reason: 'cancelled' });
  }

  async terminate(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.terminated || session.done) return;
    session.terminated = true;
    session.done = true; // onExit must not resolve with 'failed' while we stop
    await session.client?.stop();
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: 'SIGKILL', reason: 'terminated' });
  }

  /** Resume a Run from its persisted RPC session (Mercury.md section 16).
   *  With a context (worker retry path), creates the session for the new run id
   *  and resumes the parent's session file; without one, resumes an in-memory
   *  session created by a prior start() in this process. */
  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    let session = this.sessions.get(runId);
    if (!session) {
      if (!context) throw new Error(`No session state for run ${runId}; resume requires a run context`);
      session = this.createSession(context);
    }
    if (session.client?.isRunning()) {
      return { runId, events: eventsGenerator(session), exit: session.exitPromise, terminate: async () => this.terminate(runId) };
    }

    const sessionFile = context?.resumeSessionFile ?? session.sessionFile ?? readSessionPath(session.workspacePath);
    if (!sessionFile) throw new Error(`No persisted session file for run ${runId}; use retry-from-scratch`);

    const spawnCmd = this.wrapForSandbox({ run: session.run, constraints: session.constraints } as RunContext, [
      '--mode', 'rpc',
      '--cwd', session.workspacePath,
      '--resume', sessionFile,
      ...(this.opts.args ?? []),
    ]);
    const client = new RpcClient({
      cmd: spawnCmd.cmd,
      args: spawnCmd.args,
      cwd: session.workspacePath,
      env: mercuryTraceEnv(session.runId, this.opts.workerId),
      onStderr: (chunk) => {
        try {
          appendFileSync(join(session.workspacePath, OUTPUT_LOG), chunk);
        } catch {
          // best effort
        }
      },
    });
    session.client = client;
    session.done = false;
    session.cancelled = false;
    session.terminated = false;

    client.onEvent((ev) => {
      for (const translated of this.translate(session, ev)) {
        push(session, translated);
        if (translated.type === 'agent.end' && !session.exitSettled) {
          // Agent finished; resolve the exit promise (the RPC process may stay alive).
          session.done = true;
          session.exitSettled = true;
          const code = (translated.payload as { code?: number }).code ?? 0;
          session.exitResolve({ code, signal: null, reason: code === 0 ? 'completed' : 'failed' });
        }
      }
    });
    client.onExit((code, signal) => {
      if (session.done) return;
      session.done = true;
      for (const waiter of session.waiters.splice(0)) waiter(DONE);
      settleExit(session, { code, signal, reason: 'failed' });
    });

    await client.start();
    await client.prompt('Continue the task from where you left off. Read .mercury-context.json for the original task and constraints.');

    return { runId, events: eventsGenerator(session), exit: session.exitPromise, terminate: async () => this.terminate(runId) };
  }

  private translate(session: Session, ev: RpcEvent): AgentEvent[] {
    return session.translator.translate(ev);
  }
}

function buildPrompt(context: RunContext): string {
  const { run, workspace } = context;
  return [
    'You are Mercury, an autonomous coding agent. Execute the task below inside this workspace.',
    '',
    `TASK: ${run.task}`,
    '',
    `Read ${CONTEXT_FILE} in the workspace root for the full run context (repository, branch, base commit, constraints, selected skills).`,
    'The selected skills are available under .agents/skills/ — read the relevant SKILL.md files and follow their guidance.',
    '',
    `Work in this workspace (${workspace.path}). Make focused commits with clear messages as you make progress.`,
    'When the task is complete, reply with a concise summary of what you changed and why.',
  ].join('\n');
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
          if (session.queue.length > 0) yield session.queue.shift()!;
          return;
        }
        yield ev;
      }
    }
  })();
}

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


function readSessionPath(workspacePath: string): string | null {
  try {
    const raw = readFileSync(join(workspacePath, SESSION_PATH_FILE), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
