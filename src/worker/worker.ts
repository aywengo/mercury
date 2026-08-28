// Background worker: claims queued Runs, executes them via an AgentAdapter,
// translates agent output into structured events, handles input/cancel/timeout
// (Mercury.md sections 4.3, 17, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '../domain/stateMachine.ts';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentInput, Run, RunContext, ResolvedSkill,
} from '../domain/types.ts';
import type { EventStore } from '../events/eventStore.ts';
import type { Logger } from '../logger.ts';
import { RunQueue } from '../queue/runQueue.ts';
import type { RunService } from '../runs/runService.ts';
import { RunStore } from '../runs/runStore.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import type { WorkspaceManager } from '../workspace/workspaceManager.ts';

export interface WorkerDeps {
  db: DatabaseSync;
  runs: RunStore;
  events: EventStore;
  queue: RunQueue;
  skills: SkillRegistry;
  workspace: WorkspaceManager;
  adapters: Record<string, AgentAdapter>;
  runService: RunService;
  logger: Logger;
  workerId: string;
  leaseMs: number;
  leaseHeartbeatMs: number;
  pollMs: number;
  inputPollMs: number;
  retryBackoffMs: number;
  maxRetries: number;
  /** Queue depth that triggers backlog alerts (MERCURY_BACKLOG_ALERT_THRESHOLD). Default 10. */
  backlogAlertThreshold?: number;
  /** Webhook URL for backlog alerts (MERCURY_ALERT_WEBHOOK_URL). Default null (log only). */
  alertWebhookUrl?: string | null;
  /** Maximum time a run may wait for human input (MERCURY_INPUT_TIMEOUT_MS); 0 = no limit. */
  inputTimeoutMs: number;
  /** Runs in RUNNING/NEEDS_INPUT with no event activity beyond this are alerted (MERCURY_STUCK_RUN_THRESHOLD_MS); 0 = disabled. */
  stuckRunThresholdMs?: number;
  /** How often stuck runs are checked (MERCURY_STUCK_CHECK_INTERVAL_MS). Default 60s. */
  stuckCheckIntervalMs?: number;
  /** Optional sandbox manager for containerized execution (roadmap #2). */
  sandbox?: import('../sandbox/sandboxManager.ts').SandboxManager;
}

export class Worker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = new Set<string>();
  private deps: WorkerDeps;
  private backlogAlertThreshold: number;
  private alertWebhookUrl: string | null;
  /** Stateful alert flag: true while the backlog is at/above threshold (prevents spam). */
  private backlogAlerted = false;
  private stuckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
    this.backlogAlertThreshold = deps.backlogAlertThreshold ?? 10;
    this.alertWebhookUrl = deps.alertWebhookUrl ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log('info', 'worker started', {
      workerId: this.deps.workerId,
      leaseMs: this.deps.leaseMs,
      leaseHeartbeatMs: this.deps.leaseHeartbeatMs,
      pollMs: this.deps.pollMs,
      backlogAlertThreshold: this.backlogAlertThreshold,
      alertWebhookConfigured: this.alertWebhookUrl !== null,
      stuckRunThresholdMs: this.deps.stuckRunThresholdMs ?? 0,
    });
    // Stuck-run checks run on their own timer: the claim loop is blocked while a
    // run executes, and a stuck run is by definition one that is executing.
    if ((this.deps.stuckRunThresholdMs ?? 0) > 0) {
      this.stuckTimer = setInterval(
        () => this.checkStuckRuns(),
        this.deps.stuckCheckIntervalMs ?? 60_000,
      );
      this.stuckTimer.unref?.();
    }
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    this.stuckTimer = null;
    this.log('info', 'worker stopped', { workerId: this.deps.workerId });
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.deps.queue.reapExpiredLeases();
        const run = this.deps.queue.claim(this.deps.workerId, this.deps.leaseMs);
        this.checkBacklog();
        if (run) {
          this.active.add(run.id);
          try {
            await this.execute(run);
          } finally {
            this.active.delete(run.id);
          }
        } else {
          await sleep(this.deps.pollMs);
        }
      } catch (err) {
        this.log('error', 'worker loop error', { error: String(err) });
        await sleep(this.deps.pollMs);
      }
    }
  }

  private async execute(run: Run): Promise<void> {
    const log = this.logger(run.id);
    // A worker MUST verify the Run is still in a non-terminal state and that it
    // holds the lease before executing (Mercury.md section 17).
    const current = this.deps.runs.get(run.id);
    if (!current || isTerminal(current.status) || current.status !== 'QUEUED' || current.leaseOwner !== this.deps.workerId) {
      log.warn({ status: current?.status ?? 'missing', leaseOwner: current?.leaseOwner ?? null }, 'skipping run: not owned or no longer queued');
      return;
    }
    log.info({ agent: run.agent, attempt: run.attempt }, 'executing run');

    try {
      // QUEUED -> STARTING
      this.deps.runs.transition(run.id, 'STARTING', { leaseOwner: this.deps.workerId });

      // Sandboxed execution (roadmap #2): runs that request isolation must not
      // silently run unsandboxed. Fail closed BEFORE creating the workspace when
      // no container runtime is available.
      const sandbox = this.deps.sandbox;
      if (sandbox && sandbox.requiresSandbox(run)) {
        if (!(await sandbox.available())) {
          throw new Error('Run requests sandboxed execution (resourceLimits/allowedNetworks) but no container runtime is available (install docker/podman or set MERCURY_SANDBOX_RUNTIME=none to disable)');
        }
      }

      // Workspace + skills
      const workspace = await this.deps.workspace.create(run);
      // Pin the resolved base commit on the Run (section 21: retries reuse it).
      this.deps.runs.setWorkspace(
        run.id,
        workspace.branch,
        workspace.path,
        workspace.mode === 'git-worktree' ? workspace.baseCommit : undefined,
      );
      const skills = this.deps.skills.resolve(this.deps.runService.getSkills(run.id).map((s) => s.id));
      await writeSkills(workspace.path, skills);

      // STARTING -> RUNNING
      const startedAt = new Date().toISOString();
      this.deps.runs.transition(run.id, 'RUNNING', { startedAt });
      this.deps.events.append(run.id, 'run.started', { runId: run.id, startedAt });
      for (const skill of skills) {
        this.deps.events.append(run.id, 'skill.started', { skill: skill.id, version: skill.version });
      }

      const adapter = this.deps.adapters[run.agent];
      if (!adapter) throw new Error(`No adapter for agent: ${run.agent}`);

      if (sandbox && sandbox.requiresSandbox(run)) {
        this.deps.events.append(run.id, 'sandbox.enabled', { policy: sandbox.describe(run) });
      }

      const context: RunContext = {
        run,
        repository: run.repository,
        repositories: run.repositories,
        workspace,
        skills,
        constraints: run.constraints,
      };

      // Resume wiring (roadmap p11): a retry run resumes the parent's agent
      // session when the adapter supports it. The parent's session file lives in
      // the parent's workspace (.mercury-session-path); fall back to a fresh
      // start() when resume is unavailable or fails (e.g. no session file).
      let handle: Awaited<ReturnType<AgentAdapter['start']>>;
      if (run.retryOf && typeof adapter.resume === 'function') {
        const parent = this.deps.runs.get(run.retryOf);
        const parentSessionFile = parent?.workspacePath
          ? readSessionPath(parent.workspacePath)
          : null;
        if (parentSessionFile) {
          try {
            log.info({ retryOf: run.retryOf, sessionFile: parentSessionFile }, 'resuming parent agent session');
            this.deps.events.append(run.id, 'run.resuming', { runId: run.id, retryOf: run.retryOf });
            handle = await adapter.resume(run.id, { ...context, resumeSessionFile: parentSessionFile });
          } catch (err) {
            log.warn({ error: String(err) }, 'resume failed; starting fresh');
            handle = await adapter.start(context);
          }
        } else {
          log.info({ retryOf: run.retryOf }, 'no parent session file; starting fresh');
          handle = await adapter.start(context);
        }
      } else {
        handle = await adapter.start(context);
      }
      const outcome = await this.drive(run, adapter, handle, skills, startedAt);
      await this.finalize(run, outcome, skills);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      log.error({ error: message }, 'run execution failed');
      this.deps.runs.setError(run.id, message, 'infrastructure');
      this.deps.events.append(run.id, 'error', { message });
      this.deps.events.append(run.id, 'run.failed', { runId: run.id, error: message, kind: 'infrastructure' });
      this.deps.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });
      await this.maybeAutoRetry(run, 'infrastructure');
    } finally {
      this.deps.queue.releaseLease(run.id, this.deps.workerId);
    }
  }

  private async drive(
    run: Run,
    adapter: AgentAdapter,
    handle: Awaited<ReturnType<AgentAdapter['start']>>,
    skills: ResolvedSkill[],
    startedAt: string,
  ): Promise<{ status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LEASE_LOST'; exit: AgentExit; error?: string; reason?: string }> {
    const log = this.logger(run.id);
    const startedMs = Date.parse(startedAt);
    const maxDurationMs = run.constraints.maxDurationMs;
    let cancelled = false;
    let timedOut = false;
    let inputTimedOut = false;
    let leaseLost = false;

    // Lease heartbeat: if the renewal fails, we no longer own the lease (another
    // worker took the run over, or the run was reaped). Signal the drive loop to
    // abort so two workers never execute the same Run (Mercury.md sections 16-17).
    const lost = createLeaseLostSignal();
    const heartbeat = setInterval(() => {
      const renewed = this.deps.queue.renewLease(run.id, this.deps.workerId, this.deps.leaseMs);
      if (!renewed) {
        this.log('warn', 'lease lost during execution', { runId: run.id });
        lost.signal();
      }
    }, this.deps.leaseHeartbeatMs);

    // Cancellation race (roadmap p12): the loop may be blocked in iterator.next()
    // while the agent hangs; poll the cancellation flag so POST /cancel is honored
    // promptly instead of waiting for the max-duration timeout.
    const cancelSignal = createCancellationSignal(() => this.deps.runs.isCancellationRequested(run.id), 100);

    try {
      const iterator = handle.events[Symbol.asyncIterator]();

      while (true) {
        if (this.deps.runs.isCancellationRequested(run.id)) {
          cancelled = true;
          await adapter.cancel(run.id);
          break;
        }
        const remaining = maxDurationMs - (Date.now() - startedMs);
        if (remaining <= 0) {
          timedOut = true;
          await handle.terminate();
          break;
        }
        // The events generator signals completion itself (returns when the agent
        // finished AND delivered all queued events). The timeout race covers
        // agents that hang without exiting; the lease race covers takeover by
        // another worker (lease expired and was re-granted).
        const timeoutSleep = cancellableSleep(remaining);
        const timeoutRace = timeoutSleep.then(() => ({
          done: false,
          value: undefined as AgentEvent | undefined,
          timedOut: true,
        }));
        const leaseRace = lost.promise.then(() => ({
          done: false,
          value: undefined as AgentEvent | undefined,
          leaseLost: true,
        }));
        const cancelRace = cancelSignal.then(() => ({
          done: false,
          value: undefined as AgentEvent | undefined,
          cancelled: true,
        }));
        const next = await Promise.race([iterator.next(), timeoutRace, leaseRace, cancelRace]);
        timeoutSleep.cancel();
        if ((next as { cancelled?: boolean }).cancelled) {
          cancelled = true;
          await adapter.cancel(run.id);
          break;
        }
        if ((next as { leaseLost?: boolean }).leaseLost) {
          leaseLost = true;
          await adapter.cancel(run.id);
          break;
        }
        if ((next as { timedOut?: boolean }).timedOut) {
          timedOut = true;
          await handle.terminate();
          break;
        }
        if (next.done) break;
        const ev = next.value as AgentEvent;
        const handled = await this.handleAgentEvent(run, adapter, ev, skills, lost);
        if (handled === 'lease-lost') {
          leaseLost = true;
          await adapter.cancel(run.id);
          break;
        }
        if (handled === 'input-timeout') {
          inputTimedOut = true;
          // The agent is blocked on the input dialog; stop it cooperatively.
          await adapter.cancel(run.id);
          break;
        }
      }

      // Lease lost: another worker may already be re-executing the run, so do not
      // block on the (cancelled) agent's exit; requeue happens in finalize().
      if (leaseLost) {
        return { status: 'LEASE_LOST', exit: { code: null, signal: 'SIGTERM', reason: 'terminated' } };
      }

      // Final exit status (cancelled/timeout paths wait for the agent to actually exit).
      const exit = await Promise.race([
        handle.exit,
        sleep(10_000).then(() => ({ code: null, signal: 'SIGKILL', reason: 'terminated' as const })),
      ]);

      if (cancelled) return { status: 'CANCELLED', exit };
      if (timedOut) return { status: 'TIMED_OUT', exit, reason: 'max-duration' };
      if (inputTimedOut) return { status: 'TIMED_OUT', exit, reason: 'input-timeout' };
      if (exit.code === 0) return { status: 'COMPLETED', exit };
      return { status: 'FAILED', exit, error: `Agent exited with code ${exit.code ?? 'null'} (signal ${exit.signal ?? 'none'})` };
    } finally {
      clearInterval(heartbeat);
      cancelSignal.cancel();
    }
  }

  /**
   * Handle one agent event. Returns 'lease-lost' if the lease was lost while
   * waiting for human input, or 'input-timeout' if the wait exceeded the
   * configured input timeout (Mercury.md section 19).
   */
  private async handleAgentEvent(
    run: Run,
    adapter: AgentAdapter,
    ev: AgentEvent,
    skills: ResolvedSkill[],
    lost: LeaseLostSignal,
  ): Promise<'ok' | 'lease-lost' | 'input-timeout'> {
    const log = this.logger(run.id);
    if (ev.type === 'input.required') {
      this.deps.events.append(run.id, 'input.required', ev.payload);
      this.deps.runs.transition(run.id, 'NEEDS_INPUT');
      log.info({}, 'run waiting for input');
      const outcome = await this.waitForInput(run.id, lost);
      if (outcome.kind === 'lease-lost') return 'lease-lost';
      if (outcome.kind === 'input-timeout') {
        log.warn({ inputTimeoutMs: this.deps.inputTimeoutMs }, 'input wait timed out');
        return 'input-timeout';
      }
      this.deps.events.append(run.id, 'input.received', { value: outcome.input.value });
      this.deps.runs.transition(run.id, 'RUNNING');
      await adapter.sendInput(run.id, outcome.input);
      return 'ok';
    }
    if (ev.type === 'skill.started' || ev.type === 'skill.completed' || ev.type === 'skill.failed') {
      this.deps.events.append(run.id, ev.type, ev.payload);
      return 'ok';
    }
    if (ev.type === 'git.commit') {
      this.deps.events.append(run.id, 'git.commit', ev.payload);
      return 'ok';
    }
    if (ev.type === 'git.pr') {
      this.deps.events.append(run.id, 'git.pr', ev.payload);
      return 'ok';
    }
    // generic structured event passthrough (validated)
    this.deps.events.append(run.id, ev.type, ev.payload);
    return 'ok';
  }

  /**
   * Poll for human input in arrival order (concurrent requests are presented
   * in order). Resolves with the input, or a marker if the lease was lost or
   * the input timeout (section 19) expired.
   */
  private async waitForInput(runId: string, lost: LeaseLostSignal): Promise<
    | { kind: 'input'; input: AgentInput }
    | { kind: 'lease-lost' }
    | { kind: 'input-timeout' }
  > {
    const db = this.deps.db;
    const deadline = this.deps.inputTimeoutMs > 0 ? Date.now() + this.deps.inputTimeoutMs : null;
    let lastId = '';
    while (this.running) {
      const row = db
        .prepare('SELECT id, input_json FROM run_inputs WHERE run_id = ? AND id > ? ORDER BY created_at ASC LIMIT 1')
        .get(runId, lastId) as { id: string; input_json: string } | undefined;
      if (row) {
        lastId = row.id;
        return { kind: 'input', input: { value: JSON.parse(row.input_json), at: new Date().toISOString() } };
      }
      if (deadline !== null && Date.now() >= deadline) return { kind: 'input-timeout' };
      await Promise.race([sleep(this.deps.inputPollMs), lost.promise]);
      if (lost.fired) return { kind: 'lease-lost' };
    }
    throw new Error('Worker stopped while waiting for input');
  }

  private async finalize(
    run: Run,
    outcome: { status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LEASE_LOST'; exit: AgentExit; error?: string; reason?: string },
    skills: ResolvedSkill[],
  ): Promise<void> {
    const log = this.logger(run.id);
    const now = new Date().toISOString();
    const current = this.deps.runs.get(run.id);
    if (!current || isTerminal(current.status)) return;

    // Duration accounting (Mercury.md section 25): queue wait, agent duration, total.
    const createdMs = Date.parse(current.createdAt);
    const startedMs = current.startedAt ? Date.parse(current.startedAt) : null;
    const finishedMs = Date.parse(now);
    const durations = {
      status: outcome.status,
      attempt: current.attempt,
      queueWaitMs: startedMs !== null ? startedMs - createdMs : null,
      agentDurationMs: startedMs !== null ? finishedMs - startedMs : null,
      totalMs: finishedMs - createdMs,
    };

    if (outcome.status === 'LEASE_LOST') {
      // Another worker took the run over (or it was reaped). Put it back in the
      // queue so it executes exactly once, on the worker that holds the lease now.
      const requeued = this.deps.queue.requeueLostLease(run.id, this.deps.workerId);
      this.deps.events.append(run.id, 'lease.lost', { runId: run.id, requeued });
      if (requeued) {
        log.warn({ status: current.status }, 'lease lost; run requeued for another worker');
      } else {
        log.warn({ status: current.status }, 'lease lost; run no longer requeueable, leaving it as is');
      }
      return;
    }

    if (outcome.status === 'COMPLETED') {
      const commits = current.workspacePath ? await this.deps.workspace.recordCommits(current.workspacePath) : [];
      this.deps.runs.setFinalCommits(run.id, commits, null);
      this.deps.runs.transition(run.id, 'COMPLETED', { completedAt: now });
      for (const skill of skills) {
        this.deps.events.append(run.id, 'skill.completed', { skill: skill.id, version: skill.version });
      }
      this.deps.events.append(run.id, 'run.completed', {
        runId: run.id,
        commits,
        durationMs: durations.agentDurationMs,
        queueWaitMs: durations.queueWaitMs,
      });
      log.info({ commits: commits.length, ...durations }, 'run completed');
      return;
    }

    if (outcome.status === 'CANCELLED') {
      this.deps.runs.transition(run.id, 'CANCELLED', { completedAt: now });
      this.deps.events.append(run.id, 'run.cancelled', { runId: run.id, durationMs: durations.agentDurationMs });
      log.info(durations, 'run cancelled');
      return;
    }

    if (outcome.status === 'TIMED_OUT') {
      const reason = outcome.reason ?? 'max-duration';
      this.deps.runs.transition(run.id, 'TIMED_OUT', { completedAt: now });
      this.deps.events.append(run.id, 'run.timed_out', { runId: run.id, reason });
      log.warn({
        reason,
        maxDurationMs: run.constraints.maxDurationMs,
        inputTimeoutMs: this.deps.inputTimeoutMs,
        ...durations,
      }, 'run timed out');
      return;
    }

    // FAILED
    const error = outcome.error ?? 'Agent failed';
    this.deps.runs.setError(run.id, error, 'agent');
    this.deps.events.append(run.id, 'error', { message: error });
    this.deps.events.append(run.id, 'run.failed', {
      runId: run.id,
      error,
      kind: 'agent',
      durationMs: durations.agentDurationMs,
    });
    this.deps.runs.transition(run.id, 'FAILED', { completedAt: now });
    log.error({ error, ...durations }, 'run failed');
    await this.maybeAutoRetry(run, 'agent');
  }

  private async maybeAutoRetry(run: Run, kind: 'infrastructure' | 'agent'): Promise<void> {
    if (kind !== 'infrastructure') return; // agent/task failures: manual retry only
    if (run.attempt > this.deps.maxRetries) return; // maxRetries = retries allowed after the initial attempt
    const log = this.logger(run.id);
    log.info({ attempt: run.attempt, maxRetries: this.deps.maxRetries }, 'scheduling automatic retry');
    await sleep(this.deps.retryBackoffMs * run.attempt);
    try {
      this.deps.runService.retry(run.id, run.ownerId, true, { auto: true });
    } catch (err) {
      log.warn({ error: String(err) }, 'auto retry failed');
    }
  }

  /**
   * Queue backlog alerting (Mercury.md section 25). Checked after every poll.
   * Alert fires once per crossing of the threshold (stateful; resets when the
   * backlog drops below it). Webhook POST is fire-and-forget (5s timeout).
   */
  private checkBacklog(): void {
    const depth = this.deps.queue.queuedCount();
    if (depth >= this.backlogAlertThreshold) {
      if (!this.backlogAlerted) {
        this.backlogAlerted = true;
        this.log('warn', 'queue backlog above threshold', { queueDepth: depth, threshold: this.backlogAlertThreshold });
        if (this.alertWebhookUrl) {
          this.postBacklogAlert(depth).catch((err) => {
            this.log('error', 'backlog alert webhook failed', { error: String(err) });
          });
        }
      }
    } else if (this.backlogAlerted) {
      this.backlogAlerted = false;
    }
  }

  private async postBacklogAlert(queueDepth: number): Promise<void> {
    const res = await fetch(this.alertWebhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        queueDepth,
        threshold: this.backlogAlertThreshold,
        workerId: this.deps.workerId,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
  }

  /**
   * Stuck-run detection (Mercury.md section 25): runs in RUNNING or NEEDS_INPUT
   * with no event activity beyond the threshold are reported (warn log +
   * webhook). Throttled to stuckCheckIntervalMs; disabled when the threshold
   * is 0.
   */
  private checkStuckRuns(): void {
    const thresholdMs = this.deps.stuckRunThresholdMs ?? 0;
    if (thresholdMs <= 0) return;
    const now = Date.now();

    const stuck: { runId: string; status: string; idleMs: number }[] = [];
    for (const status of ['RUNNING', 'NEEDS_INPUT'] as const) {
      const { runs } = this.deps.runs.list({ status, limit: 200 });
      for (const run of runs) {
        const lastActivity = this.deps.events.lastActivity(run.id);
        const refMs = lastActivity
          ? Date.parse(lastActivity)
          : Date.parse(run.startedAt ?? run.createdAt);
        const idleMs = now - refMs;
        if (idleMs >= thresholdMs) stuck.push({ runId: run.id, status, idleMs });
      }
    }
    if (stuck.length === 0) return;

    this.log('warn', 'runs stuck beyond inactivity threshold', {
      runIds: stuck.map((s) => s.runId),
      thresholdMs,
    });
    if (this.alertWebhookUrl) {
      fetch(this.alertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ts: new Date().toISOString(),
          type: 'stuck_runs',
          runs: stuck,
          thresholdMs,
          workerId: this.deps.workerId,
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch((err) => {
        this.log('error', 'stuck-run alert webhook failed', { error: String(err) });
      });
    }
  }

  private logger(runId: string) {
    return this.deps.logger.child({ runId, workerId: this.deps.workerId });
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>): void {
    this.deps.logger[level]({ workerId: this.deps.workerId, ...fields }, msg);
  }
}

async function writeSkills(workspacePath: string, skills: ResolvedSkill[]): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const skill of skills) {
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = join(workspacePath, '.agents', 'skills', skill.id, rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content);
    }
  }
}

/** Read the persisted agent session file from a workspace (.mercury-session-path). */
function readSessionPath(workspacePath: string): string | null {
  try {
    const raw = readFileSync(join(workspacePath, '.mercury-session-path'), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One-shot, idempotent signal: the run's lease was lost. */
interface LeaseLostSignal {
  promise: Promise<void>;
  fired: boolean;
  signal(): void;
}

function createLeaseLostSignal(): LeaseLostSignal {
  let resolveFn: (() => void) | null = null;
  const s: LeaseLostSignal = {
    promise: new Promise<void>((resolve) => {
      resolveFn = resolve;
    }),
    fired: false,
    signal(): void {
      if (s.fired) return;
      s.fired = true;
      if (resolveFn) resolveFn();
    },
  };
  return s;
}

/** One-shot, cancellable signal that fires when `check()` returns true (polled). */
interface CancellationSignal extends Promise<void> {
  cancel(): void;
}

function createCancellationSignal(check: () => boolean, intervalMs: number): CancellationSignal {
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveFn: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timer = setInterval(() => {
      if (check()) resolveFn?.();
    }, intervalMs);
  }) as CancellationSignal;
  promise.cancel = () => {
    if (timer) clearInterval(timer);
    timer = null;
    resolveFn = null;
  };
  return promise;
}

interface CancellablePromise<T> extends Promise<T> {
  cancel(): void;
}

function cancellableSleep<T>(ms: number, value?: T): CancellablePromise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: ((v: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(() => resolve(value as T), ms);
  }) as CancellablePromise<T>;
  promise.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (resolveFn) resolveFn(value as T);
  };
  return promise;
}
