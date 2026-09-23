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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExitGate, rearmExitGate, settleExit } from './exitSettlement.ts';
import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, Run, RunConstraints, RunContext, AgentCapabilities, AgentVersionInfo } from '../domain/types.ts';

import { probeVersion } from './versionProbe.ts';
import { RpcClient, type RpcEvent } from './rpc/rpcClient.ts';
import { EventTranslator, buildExtensionUiResponse } from './eventTranslation.ts';
import type { SandboxManager } from '../sandbox/sandboxManager.ts';
import { assertSafeSkillId, resolveContained } from '../skills/skillRegistry.ts';
import { SKILL_ID as KNOWLEDGE_SKILL_ID , CONTEXT_FILE } from '../knowledge/materialize.ts';

const SESSION_DIR_NAME = '.mercury-sessions';
const SESSION_PATH_FILE = '.mercury-session-path';
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
  /** The preset pointer from the Run's context, kept so the resume prompt names the role
   *  instruction the way the first prompt did (#722, docs/crew/role-presets.md section 8). */
  preset?: NonNullable<RunContext['preset']>;
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
  /**
   * PrimeAgent is the only backend Mercury can drive a goal through today.
   *
   * The thresholds are not decoration. `/goal` has existed since 0.0.1, but it is an
   * interactive slash command; the headless argv Mercury needs -- `--goal` and
   * `--goal-token-budget` -- landed fourteen minor versions later in 0.3.3 (2026-07-23,
   * upstream PR #514). A row reading "primeagent: goals yes" would green-light a `--goal`
   * against a 0.2.x install, which rejects the flag at argument-parse time.
   *
   * `contract` and `gates` are absent on purpose: PrimeAgent has no equivalent concept, so
   * Mercury must reject those fields rather than accept and silently drop them.
   */
  readonly capabilities: AgentCapabilities = {
    goals: { set: '0.3.3', track: '0.3.3', tokenBudget: '0.3.3' },
    // RPC mode + the goal argv Mercury needs both exist at the goals-matrix floor; the
    // adapter has never been driven against anything older (docs/goals.md 13.2).
    minVersion: '0.3.3',
    static: {
      // Measured: the worker writes skill files to <workspace>/.agents/skills and this adapter also
      // passes each skill's workspace path on argv, so PrimeAgent reads them from disk.
      skills: 'workspacePaths',
      humanInput: true,
      resume: true,
      // Role Presets (docs/crew/role-presets.md §8): the prompt already names workspace files the
      // agent should read (.mercury-context.json), so the materialized instruction reaches the
      // agent the same way -- prompt-reference. No per-run model argv exists; a preset that sets
      // one fails closed instead of silently ignored.
      roleInstruction: 'prompt-reference',
      sandbox: true,
      mcp: 'none',
      // RPC mode carries tool callbacks, and the shared translator maps them to tool.started /
      // tool.completed / tool.failed (eventTranslation.ts). Observed on real Runs, not inferred:
      // `run_933c68e4684a498d` recorded 47 events including tool calls. The contrast with Hermes
      // ('none') is the point of the field -- issue #594.
      toolEvents: 'structured',
    },
  };

  /** PrimeAgent prints a bare dotted version (`0.9.4`), so the default parser applies.
   *  Probes `this.cmd` -- the configured path -- never a bare `prime-agent` resolved
   *  through PATH (docs/goals.md 13.3). */
  detectVersion(): Promise<AgentVersionInfo> {
    return probeVersion({ cmd: this.cmd });
  }

  private cmd: string;
  private opts: PrimeAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(cmd: string, opts: PrimeAgentAdapterOptions = {}) {
    this.cmd = cmd;
    this.opts = opts;
  }

  /**
   * Goal flags for a fresh session.
   *
   * Only ever added to `start()`, never to `resume()`: `--goal` seeds a goal for a NEW root
   * session, and a resumed session already carries its goal in the session file. Re-seeding on
   * resume would either be rejected or reset the objective mid-flight, and a goal that silently
   * restarts its usage counters on every resume makes the budget meaningless.
   *
   * The objective is passed verbatim as one argv element, never through a shell, so quoting is
   * not a concern and the value cannot inject arguments.
   */
  private goalArgs(context: RunContext): string[] {
    const goal = context.goal;
    if (!goal) return [];
    const args: string[] = ['--goal', goal.objective];
    if (goal.tokenBudget !== undefined) {
      // PrimeAgent rejects a non-positive budget at parse time. Mercury validated it at
      // admission, so reaching here with a bad value means something upstream regressed; pass it
      // through and let the harness refuse rather than silently dropping the budget -- a goal
      // that quietly loses its budget is a goal that will not stop when intended.
      args.push('--goal-token-budget', String(goal.tokenBudget));
    }
    return args;
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
      ...(context.preset ? { preset: context.preset } : {}),
      client: null,
      workspacePath,
      sessionFile: null,
      translator: new EventTranslator(),
      done: false,
      cancelled: false,
      terminated: false,
      queue: [],
      waiters: [],
        ...createExitGate(),
    };
    this.sessions.set(runId, session);
    return session;
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const workspacePath = context.workspace.path;

    // Run context file the task prompt points the agent at.
    writeContextFile(workspacePath, context);

    const sessionDir = join(workspacePath, this.opts.sessionDirName ?? SESSION_DIR_NAME);
    mkdirSync(sessionDir, { recursive: true });

    const session = this.createSession(context);

    const skillArgs: string[] = [];
    for (const skill of context.skills) {
      // Defence in depth (issue #95). Skill ids are already validated by SkillRegistry.resolve,
      // which is what normally populates context.skills -- but this line turns skill.id into a
      // filesystem path handed to a child process, and it is the only place outside the registry
      // that does so. A context built by any other route (a future replay path, a test double, a
      // retry that rehydrates stored ids without re-resolving) would otherwise get an unvalidated
      // `..` straight into the path.
      //
      // join() does not contain: join(ws, '.agents', 'skills', '../../etc') escapes the workspace
      // silently. assertSafeSkillId rejects anything not matching ^[a-z0-9][a-z0-9._-]*$, so the
      // id cannot carry a traversal of its own.
      //
      // resolveContained is still required on top of that, because a safe id is not the only way to
      // escape: the workspace is a checkout of a repo that may be untrusted, so `.agents/skills`
      // itself can arrive as a SYMLINK pointing anywhere on the host. A validated id joined onto
      // that symlink resolves outside the workspace with nothing wrong about the id. This is the
      // same reasoning as issue #58, whose resolveContained already documents that the last
      // component of such a root is created by checking out an untrusted repo.
      //
      // Ancestry symlinks stay allowed (macOS resolves /tmp to /private/tmp), so this rejects only
      // a symlink at or below the workspace, not a workspace that happens to live under one.
      const skillPath = resolveContained(workspacePath, join('.agents', 'skills', assertSafeSkillId(skill.id)));
      skillArgs.push('--skill', skillPath);
    }

    // The pack, rendered as a skill (docs/knowledge-base.md 9.3). PrimeAgent opens this directory
    // unprompted, so the knowledge reaches the harness through a channel it already reads and no new
    // protocol is needed. The neutral files under .mercury/ stay in place for every other backend.
    //
    // Gated on the directory existing rather than on `context.knowledge` alone. The pointer is written
    // by the worker in the same step that writes the files, so in the normal path the two agree -- but
    // advertising a skill directory that is not there would make the Run's own argv a lie about its
    // workspace, and a Run whose pack was never materialized should look exactly like that.
    if (context.knowledge && !context.skills.some((sk) => sk.id === KNOWLEDGE_SKILL_ID)) {
      try {
        const knowledgeSkillPath = resolveContained(
          workspacePath, join('.agents', 'skills', assertSafeSkillId(KNOWLEDGE_SKILL_ID)));
        if (existsSync(join(knowledgeSkillPath, 'SKILL.md'))) skillArgs.push('--skill', knowledgeSkillPath);
      } catch {
        // A workspace whose .agents/skills root is a symlink out of the tree. The pack is still in the
        // neutral files, so the Run loses a rendering and not its knowledge; refusing to spawn over it
        // would trade a degraded Run for a failed one.
      }
    }

    const spawnCmd = this.wrapForSandbox(context, [
      '--mode', 'rpc',
      '--cwd', workspacePath,
      '--session-dir', sessionDir,
      ...skillArgs,
      ...this.goalArgs(context),
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
          // `done` is set under the same guard as before; settlement then goes through the shared
          // helper instead of repeating its first-writer-wins check inline (issue #148).
          session.done = true;
          const code = (translated.payload as { code?: number }).code ?? 0;
          settleExit(session, { code, signal: null, reason: code === 0 ? 'completed' : 'failed' });
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
    session.client.sendExtensionUiResponse(buildExtensionUiResponse(requestId, method, input.value));
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
    // Guard on `terminated` alone, NOT `done` (issue #46). `done` is already true on the
    // success path: `agent.end` settles the exit promise and marks the session done while
    // the RPC process is still running. Returning early there -- which is what this did --
    // meant the worker's cleanup could never reach stop(), so every successful run leaked a
    // live `prime-agent --mode rpc` process. stop() is idempotent (it returns immediately
    // when there is no child), so running it after a natural exit is harmless.
    if (!session || session.terminated) return;
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

    // The retry path may resolve pointers the first attempt did not carry (a preset added between
    // attempts, a pack materialized after a crash). Adopt the retry context's pointers the same
    // way createSession() would have (#722).
    if (context?.preset) session.preset = context.preset;
    // A retry runs in a fresh workspace; without this rewrite the resume prompt names a context
    // file that is not there. In-process resumes pass no context and keep the file start() wrote.
    if (context) writeContextFile(session.workspacePath, context);
    // The first run's gate settled; a resumed session must be able to settle its own exit, or
    // agent.end on the resume cannot mark done and the events generator never returns.
    rearmExitGate(session);

    const spawnCmd = this.wrapForSandbox({ run: session.run, constraints: session.constraints } as RunContext, [
      '--mode', 'rpc',
      '--cwd', session.workspacePath,
      '--resume', sessionFile,
      // No goal flags here on purpose -- see goalArgs(). The resumed session already owns the
      // goal it was started with. The preset line IS re-sent, but in the resume one-liner below,
      // not here: see the prompt call after client.start().
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
          // `done` is set under the same guard as before; settlement then goes through the shared
          // helper instead of repeating its first-writer-wins check inline (issue #148).
          session.done = true;
          const code = (translated.payload as { code?: number }).code ?? 0;
          settleExit(session, { code, signal: null, reason: code === 0 ? 'completed' : 'failed' });
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
    // Role Preset (#722, docs/crew/role-presets.md section 8): the resume prompt repeats the
    // preset reference with the first prompt's exact wording. The prime resume one-liner already
    // re-states the context-file pointer; the role is the same kind of pointer, and
    // prompt-reference adapters apply the preset on resume (section 8) rather than relying on
    // history carrying it.
    const presetLine = session.preset
      ? ` You are filling the role: ${session.preset.role}. Your role instructions are in`
        + ` ${session.preset.instructionPath} — read them before starting and follow them.`
      : '';
    await client.prompt('Continue the task from where you left off. Read .mercury-context.json for the original task and constraints.'
      + presetLine);

    return { runId, events: eventsGenerator(session), exit: session.exitPromise, terminate: async () => this.terminate(runId) };
  }

  private translate(session: Session, ev: RpcEvent): AgentEvent[] {
    return session.translator.translate(ev);
  }
}

/**
 * The run-context file the prompts point at (docs/knowledge-base.md 9.2). Written by start() and
 * rewritten by resume() when the retry path supplies a context: a retry runs in a FRESH workspace,
 * so without the rewrite the resume prompt would name a file that is not there (#744 review).
 */
function writeContextFile(workspacePath: string, context: RunContext): void {
  writeFileSync(join(workspacePath, CONTEXT_FILE), JSON.stringify({
    runId: context.run.id,
    task: context.run.task,
    repository: context.repository,
    repositories: context.repositories,
    workspace: workspacePath,
    branch: context.workspace.branch,
    baseCommit: context.workspace.baseCommit,
    skills: context.skills.map((s) => ({ id: s.id, version: s.version, hash: s.hash })),
    constraints: context.constraints,
    // The pointer, not the notes. These adapters' prompts already tell the agent to read this file, so
    // a harness finds the pack with no prompt change and no new channel (section 9.2). Omitted rather
    // than written as null when there is no pack, so a Run without knowledge has a context file
    // identical to the one it had before this feature existed.
    ...(context.knowledge ? { knowledge: context.knowledge } : {}),
    // Role Preset (docs/crew/role-presets.md section 7): id, version, role, trust, content
    // hash and the workspace-relative instruction path — the identity fields that let the
    // agent see which bytes it runs under. Omitted when the Run has no preset, so the
    // context file stays byte-identical to the one it had before presets existed.
    ...(context.preset ? {
      preset: {
        id: context.preset.id,
        version: context.preset.version,
        role: context.preset.role,
        trust: context.preset.trust,
        contentHash: context.preset.contentHash,
        instructionPath: context.preset.instructionPath,
      },
    } : {}),
  }, null, 2));
}

function buildPrompt(context: RunContext): string {
  const { run, workspace } = context;
  // Role Preset (docs/crew/role-presets.md section 8): prompt-reference, not a system channel.
  // Omitted when there is no preset, so the prompt stays byte-identical for preset-less Runs.
  const presetLine = context.preset
    ? [
        '',
        `You are filling the role: ${context.preset.role}. Your role instructions are in`,
        `${context.preset.instructionPath} — read them before starting and follow them.`,
      ].join('\n')
    : '';
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
    presetLine,
  ].filter((part) => part !== '').join('\n');
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

