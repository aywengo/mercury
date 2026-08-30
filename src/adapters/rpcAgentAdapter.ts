// RpcAgentAdapter: generic adapter for any CLI agent that speaks the RPC JSONL
// protocol family (PrimeAgent, Pi Agent, Oh my Pi, ...). See
// docs/agent-adapters.md section 6.
//
// The RPC protocol family (verified against prime-agent docs/rpc.md, pi.dev/docs,
// omp.sh/docs) shares one vocabulary: strict JSONL commands on stdin
// (prompt/abort/get_state/...), responses + events on stdout
// (agent_start/end, turn_start/end, message_update/end, tool_execution_start/end,
// extension_ui_request). Mercury's RpcClient + EventTranslator already implement
// this protocol; this adapter is a thin declarative-config layer over them.
//
// Everything is config: how to spawn, protocol knobs (mode flag/value, readiness
// delay, stop grace), vendor event types to ignore, event mapping overrides,
// human input, session resume. No per-agent code.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, Run, RunConstraints, RunContext,
} from '../domain/types.ts';
import { RpcClient, type RpcEvent } from './rpc/rpcClient.ts';
import { EventTranslator, buildExtensionUiResponse } from './eventTranslation.ts';
import type { LocalAgentEventMap } from './localAgentAdapter.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';

const SESSION_DIR_NAME = '.mercury-sessions';
const SESSION_PATH_FILE = '.mercury-session-path';
const CONTEXT_FILE = '.mercury-context.json';
const OUTPUT_LOG = 'agent-output.log';

// --- config schema (docs/agent-adapters.md section 6.2) ---------------------

export interface RpcAgentProtocolConfig {
  /** Flag that selects the mode, e.g. "--mode" (default). */
  modeFlag?: string;
  /** Mode value, e.g. "rpc" (default). */
  modeValue?: string;
  /** Startup readiness delay before declaring the process healthy (ms). */
  readyDelayMs?: number;
  /** SIGTERM -> SIGKILL grace period on stop (ms). */
  stopGraceMs?: number;
  /** Vendor event types to drop before translation (e.g. omp's "ready",
   *  "negotiate_protocol", "subagent_lifecycle", "host_tool_call"). */
  ignoreEventTypes?: string[];
}

export interface RpcAgentInputConfig {
  /** Bridge extension_ui_request dialogs to Mercury input.required (default true). */
  enabled?: boolean;
  /** Dialog methods to bridge (default: select/confirm/input/editor). */
  dialogMethods?: string[];
}

export interface RpcAgentResumeConfig {
  /** Persist the RPC session file and support resume (default true). */
  enabled?: boolean;
  /** Flag that selects the session directory, e.g. "--session-dir" (default). */
  sessionDirFlag?: string;
}

export interface RpcAgentConfig {
  id: string;
  description: string;
  /** Binary path or name (e.g. "pi", "omp", "prime-agent"). */
  command: string;
  /** Static args appended after the mode flag (e.g. --provider, --model). */
  args?: string[];
  /** Working directory for the spawned process (default: the Run workspace). */
  cwd?: string;
  protocol?: RpcAgentProtocolConfig;
  /** Event mapping overrides; empty = the shared RPC translation. */
  eventMap?: LocalAgentEventMap;
  input?: RpcAgentInputConfig;
  resume?: RpcAgentResumeConfig;
  /** Extra env vars for the spawned process. */
  env?: Record<string, string>;
}

export interface RpcAgentAdapterOptions {
  sandbox?: SandboxManager;
  workerId?: string;
}

// --- validation -------------------------------------------------------------

export function validateRpcAgentConfig(cfg: RpcAgentConfig): void {
  const err = (msg: string): never => { throw new Error(`RpcAgentConfig "${cfg.id}": ${msg}`); };
  if (!cfg.id) err('id is required');
  if (!cfg.command) err('command is required');
  if (cfg.protocol?.modeFlag !== undefined && !cfg.protocol.modeFlag) err('protocol.modeFlag must be a non-empty string');
  if (cfg.protocol?.modeValue !== undefined && !cfg.protocol.modeValue) err('protocol.modeValue must be a non-empty string');
  if (cfg.protocol?.readyDelayMs !== undefined && (typeof cfg.protocol.readyDelayMs !== 'number' || cfg.protocol.readyDelayMs < 0)) {
    err('protocol.readyDelayMs must be a non-negative number');
  }
  if (cfg.protocol?.stopGraceMs !== undefined && (typeof cfg.protocol.stopGraceMs !== 'number' || cfg.protocol.stopGraceMs < 0)) {
    err('protocol.stopGraceMs must be a non-negative number');
  }
  if (cfg.protocol?.ignoreEventTypes !== undefined && !Array.isArray(cfg.protocol.ignoreEventTypes)) {
    err('protocol.ignoreEventTypes must be an array of event type strings');
  }
  if (cfg.input?.dialogMethods !== undefined && !Array.isArray(cfg.input.dialogMethods)) {
    err('input.dialogMethods must be an array of method strings');
  }
}

// --- session state ----------------------------------------------------------

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

// --- adapter ----------------------------------------------------------------

export class RpcAgentAdapter implements AgentAdapter {
  private cfg: RpcAgentConfig;
  private opts: RpcAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(cfg: RpcAgentConfig, opts: RpcAgentAdapterOptions = {}) {
    validateRpcAgentConfig(cfg);
    this.cfg = cfg;
    this.opts = opts;
  }

  get config(): RpcAgentConfig {
    return this.cfg;
  }

  /** Wrap the spawn command in a container when the run requests isolation. */
  private wrapForSandbox(run: RunContext, args: string[]): { cmd: string; args: string[] } {
    const sandbox = this.opts.sandbox;
    if (!sandbox || !sandbox.requiresSandbox(run.run)) return { cmd: this.cfg.command, args };
    const runWithWs = { ...run.run, workspacePath: run.run.workspacePath ?? run.workspace.path };
    const wrapped = sandbox.buildCommand(runWithWs, this.cfg.command, args);
    return { cmd: wrapped.cmd, args: wrapped.args };
  }

  /** Build the RPC spawn argv: [command, ...args, --cwd, --session-dir].
   *  The mode flag/value are added by RpcClient.start() (modeFlag/modeValue options). */
  private buildArgv(context: RunContext, sessionDir: string): { cmd: string; args: string[] } {
    const cfg = this.cfg;
    const sessionDirFlag = cfg.resume?.sessionDirFlag ?? '--session-dir';
    const argv: string[] = [
      '--cwd', context.workspace.path,
      sessionDirFlag, sessionDir,
      ...(cfg.args ?? []),
    ];
    return this.wrapForSandbox(context, argv);
  }

  /** Trace context exported to the agent process (Mercury.md section 25). */
  private traceEnv(runId: string): Record<string, string> {
    const env: Record<string, string> = { MERCURY_RUN_ID: runId, MERCURY_TRACE_ID: runId };
    if (this.opts.workerId) env.MERCURY_WORKER_ID = this.opts.workerId;
    return env;
  }

  /** Drop vendor event types the config says to ignore (e.g. omp's extras). */
  private shouldIgnore(ev: RpcEvent): boolean {
    const ignored = this.cfg.protocol?.ignoreEventTypes;
    return ignored !== undefined && ignored.includes(ev.type);
  }

  private attachClient(session: Session, client: RpcClient): void {
    session.client = client;
    client.onEvent((ev) => {
      if (this.shouldIgnore(ev)) return;
      for (const translated of session.translator.translate(ev)) {
        push(session, translated);
        if (translated.type === 'agent.end' && !session.exitSettled) {
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
  }

  private spawnClient(session: Session, argv: { cmd: string; args: string[] }): RpcClient {
    const client = new RpcClient({
      cmd: argv.cmd,
      args: argv.args,
      cwd: this.cfg.cwd ?? session.workspacePath,
      env: { ...this.traceEnv(session.runId), ...(this.cfg.env ?? {}) },
      readyDelayMs: this.cfg.protocol?.readyDelayMs,
      modeFlag: this.cfg.protocol?.modeFlag,
      modeValue: this.cfg.protocol?.modeValue,
      onStderr: (chunk) => {
        try {
          appendFileSync(join(session.workspacePath, OUTPUT_LOG), chunk);
        } catch {
          // best effort
        }
      },
    });
    this.attachClient(session, client);
    return client;
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

    const sessionDir = join(workspacePath, SESSION_DIR_NAME);
    mkdirSync(sessionDir, { recursive: true });

    const session = this.createSession(context);
    const argv = this.buildArgv(context, sessionDir);
    const client = this.spawnClient(session, argv);

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
      if (this.cfg.resume?.enabled !== false) {
        try {
          const state = await client.getState();
          if (state.success && typeof state.data?.sessionFile === 'string') {
            session.sessionFile = state.data.sessionFile;
            writeFileSync(join(workspacePath, SESSION_PATH_FILE), state.data.sessionFile);
          }
        } catch {
          // non-fatal: resume falls back to retry-from-scratch
        }
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
    if (this.cfg.input?.enabled === false) throw new Error(`Agent ${this.cfg.id} does not accept input`);
    const pending = session.translator.pending;
    if (!pending) throw new Error(`Run ${runId} is not waiting for input`);
    const { requestId, method } = pending;
    session.translator.clearPending();
    session.client.sendExtensionUiResponse(buildExtensionUiResponse(requestId, method, input.value));
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
    if (this.cfg.resume?.enabled === false) throw new Error(`Agent ${this.cfg.id} does not support resume`);
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

    const sessionDir = join(session.workspacePath, SESSION_DIR_NAME);
    const argv = this.buildArgv({
      run: session.run,
      constraints: session.constraints,
      workspace: { path: session.workspacePath, branch: 'agent/' + session.runId, baseCommit: 'abc123', mode: 'copy' },
    } as RunContext, sessionDir);
    // resume: replace --session-dir with --resume <sessionFile>
    const resumeFlag = this.cfg.resume?.sessionDirFlag ?? '--session-dir';
    const args = argv.args.filter((a) => a !== resumeFlag && a !== sessionDir);
    args.push('--resume', sessionFile);

    const client = this.spawnClient(session, { cmd: argv.cmd, args });
    session.done = false;
    session.cancelled = false;
    session.terminated = false;

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

