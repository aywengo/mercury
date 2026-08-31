// Background worker: claims queued Runs, executes them via an AgentAdapter,
// translates agent output into structured events, handles input/cancel/timeout
// (Mercury.md sections 4.3, 17, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '../domain/stateMachine.ts';
import { assertSafeSkillId, resolveContained } from '../skills/skillRegistry.ts';
import type { Redactor } from '../domain/redact.ts';
import { isEventType } from '../domain/types.ts';
import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, Run, RunContext, ResolvedSkill,
} from '../domain/types.ts';
import type { EventStore } from '../events/eventStore.ts';
import type { Logger } from '../logger.ts';
import { RunQueue, LEASE_EXPIRED_ERROR } from '../queue/runQueue.ts';
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
  /** Queue depth that triggers backlog alerts (MERCURY_BACKLOG_ALERT_THRESHOLD). Default 10. */
  backlogAlertThreshold?: number;
  /** Webhook URL for backlog alerts (MERCURY_ALERT_WEBHOOK_URL). Default null (log only). */
  alertWebhookUrl?: string | null;
  /** Optional secret redactor; run error messages are redacted at write time (issue #36). */
  redactor?: Redactor;
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
  // Set by stop(). Unlike `running`, which only stops the claim loop from picking up NEW
  // runs, this also tells a run already being driven to hand itself back (issue #51).
  private shuttingDown = false;
  private shutdownSignals = new Set<LeaseLostSignal>();
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
    // Wake the drive loop of any run in flight so it can requeue itself (issue #51).
    // Without this, stop() only prevented NEW claims: the in-flight run kept driving an
    // agent whose process the shutting-down process was about to abandon, and its lease was
    // left to expire so the reaper failed the run and auto-retried it.
    this.shuttingDown = true;
    for (const sig of [...this.shutdownSignals]) sig.signal();
    this.log('info', 'worker stopped', { workerId: this.deps.workerId });
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * How many runs this worker is still driving. A shutdown handler needs this to know when
   * it is safe to close the database: stop() only signals, and the in-flight run still has
   * to terminate its agent and requeue itself before the connection can go away (issue #51).
   */
  activeCount(): number {
    return this.active.size;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Reap expired leases (worker crash). Active runs are marked FAILED by the
        // queue; append the terminal event here so the audit trail stays complete
        // (the queue has no EventStore access). The queue only reports runs this
        // worker actually transitioned (changes === 1), so no duplicate events.
        // The failure events are appended from INSIDE the reap transaction (issue #61).
        // They used to be appended here, after reapExpiredLeases() had committed, so a crash
        // between the two left the run FAILED with no `error` and no `run.failed` event --
        // the state said it failed and the timeline said nothing happened.
        const reaped = this.deps.queue.reapExpiredLeases(Date.now(), (runId) => {
          const row = this.deps.runs.get(runId);
          const durationMs = row?.startedAt ? Date.now() - Date.parse(row.startedAt) : null;
          this.deps.events.append(runId, 'error', { message: LEASE_EXPIRED_ERROR });
          this.deps.events.append(runId, 'run.failed', {
            runId,
            error: LEASE_EXPIRED_ERROR,
            kind: 'infrastructure',
            durationMs,
          });
        });
        if (reaped.failed.length > 0) {
          this.log('warn', 'reaped runs with expired leases', { runIds: reaped.failed });
        }
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
      // Release before returning (issue #71). This return sits ABOVE the try/finally that
      // owns releaseLease, so a skipped run -- typically one cancelled between claim and
      // execute -- kept lease_owner and lease_expires_at forever. Nothing ever revisits it:
      // the reaper only selects non-terminal statuses, and the run is terminal by definition
      // of being skipped here. The claim was ours, so dropping it is ours to do.
      //
      // releaseLease is safe on every branch of the guard above: it matches
      // `lease_owner = ?` with OUR worker id, so a run owned by another worker is untouched,
      // and it no-ops unless the run is terminal, so a run that merely moved on is left alone.
      this.deps.queue.releaseLease(run.id, this.deps.workerId);
      return;
    }
    log.info({ agent: run.agent, attempt: run.attempt }, 'executing run');

    // Declared out here so the finally can reach it (issues #46, #47). The agent handle is
    // the one resource in this method that outlives a throw, and until now nothing owned it:
    // terminate() was called only on the timeout path, so a successful run left the RPC
    // process running and a run that threw on a state transition unwound past any cleanup,
    // leaving a live agent writing into a workspace nobody was watching.
    let handle: AgentHandle | null = null;

    try {
      // QUEUED -> STARTING
      this.deps.runs.transition(run.id, 'STARTING', { leaseOwner: this.deps.workerId });

      // Sandboxed execution (roadmap #2): runs that request isolation must not
      // silently run unsandboxed. Fail closed BEFORE creating the workspace when
      // no container runtime is available.
      const sandbox = this.deps.sandbox;
      if (sandbox && sandbox.requiresSandbox(run)) {
        if (!(await sandbox.available())) {
          throw new Error('Run requests sandboxed execution (resourceLimits/allowedNetworks) but no container runtime is available (install docker/podman, or configure the worker without a sandbox runtime to disable sandboxing)');
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
      // Kill the agent BEFORE handing the run back to the queue (issue #51).
      //
      // finalize() requeues on the SHUTDOWN path, and a requeued run is QUEUED with no lease
      // -- instantly claimable. The finally block below also terminates, but it runs AFTER
      // finalize, so on this path the window was open: another worker could claim the run and
      // start a second agent against a workspace this agent was still writing into. The
      // finally's own comment states the intent ("we want the process gone before another
      // worker can claim the run"); finalize() had quietly moved that guarantee earlier.
      //
      // terminate() is idempotent (it sets `terminated` before acting), so the finally's call
      // is a no-op after this one.
      if (outcome.status === 'SHUTDOWN' && handle) {
        try {
          await handle.terminate();
        } catch (termErr) {
          log.warn({ error: String(termErr instanceof Error ? termErr.message : termErr) }, 'agent terminate before requeue failed');
        }
      }
      await this.finalize(run, outcome, skills);
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err);
      const message = this.deps.redactor ? this.deps.redactor.redact(raw) : raw;
      log.error({ error: message }, 'run execution failed');
      // Skip the failure bookkeeping when the run is already terminal (issue #47). On the
      // cancel race the drive loop's transition to RUNNING throws, and this block then threw
      // a SECOND time on the invalid `CANCELLED -> FAILED`, unwinding before any cleanup --
      // which is how a cancelled run kept a live agent writing into its workspace. The
      // cancellation already recorded the outcome, so overwriting it is both wrong and fatal.
      const settled = this.deps.runs.get(run.id);
      if (settled && isTerminal(settled.status)) {
        log.warn({ status: settled.status }, 'run already terminal; skipping failure bookkeeping');
      } else {
        this.deps.runs.setError(run.id, message, 'infrastructure');
        this.deps.events.append(run.id, 'error', { message });
        this.deps.events.append(run.id, 'run.failed', { runId: run.id, error: message, kind: 'infrastructure' });
        this.deps.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });
        await this.maybeAutoRetry(run, 'infrastructure');
      }
    } finally {
      // Terminate on EVERY exit path -- success, cancellation, timeout, lease loss, and the
      // throwing one (issues #46, #47). Ownership lives here rather than in each error branch
      // so that no new early return or throw can reintroduce the leak.
      //
      // Before this, the success path never terminated at all (one live `prime-agent --mode
      // rpc` per completed run), and on the cancel race the second invalid-transition throw
      // in the catch below unwound before any terminate() call, leaving the agent running.
      //
      // Runs before releaseLease: we want the process gone before another worker can claim
      // the run. Failures are logged, not propagated -- nothing downstream can act on them
      // here, and letting one throw would skip releaseLease and strand the lease.
      if (handle) {
        try {
          await handle.terminate();
        } catch (termErr) {
          log.warn({ error: String(termErr instanceof Error ? termErr.message : termErr) }, 'agent terminate failed');
        }
      }
      // Release the adapter's per-run state LAST (issues #62, #97). Every adapter keyed a
      // session by runId and nothing ever removed it, so a long-lived worker accumulated one
      // Session -- run row, RPC client, stderr buffer, event queue -- per run for the lifetime
      // of the process.
      //
      // This MUST come after terminate(): adapters resolve the session by runId inside
      // terminate(), so pruning first makes terminate() find nothing and return without
      // stopping the process, which is the exact leak #46 fixed.
      //
      // Guarded for the same reason terminate() is, two lines above: this is cleanup-only code
      // and sits before releaseLease(), so a throw from any adapter's dispose() -- now or in a
      // future adapter -- would skip releaseLease and strand the lease. A leaked session is
      // strictly better than a stranded run, so failures are logged and swallowed.
      try {
        this.deps.adapters[run.agent]?.dispose?.(run.id);
      } catch (disposeErr) {
        log.warn({ error: String(disposeErr instanceof Error ? disposeErr.message : disposeErr) }, 'adapter dispose failed');
      }
      this.deps.queue.releaseLease(run.id, this.deps.workerId);
    }
  }

  private async drive(
    run: Run,
    adapter: AgentAdapter,
    handle: Awaited<ReturnType<AgentAdapter['start']>>,
    skills: ResolvedSkill[],
    startedAt: string,
  ): Promise<{ status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LEASE_LOST' | 'SHUTDOWN'; exit: AgentExit; error?: string; reason?: string }> {
    const log = this.logger(run.id);
    const startedMs = Date.parse(startedAt);
    const maxDurationMs = run.constraints.maxDurationMs;
    let cancelled = false;
    let timedOut = false;
    let inputTimedOut = false;
    let leaseLost = false;
    let shuttingDown = false;

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

    // Graceful-shutdown signal (issue #51). Registered on the worker so stop() can raise it
    // while this loop is parked in iterator.next(), and always unregistered in the finally.
    const shutdown = createLeaseLostSignal();
    if (this.shuttingDown) shutdown.signal();
    this.shutdownSignals.add(shutdown);

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
        const shutdownRace = shutdown.promise.then(() => ({
          done: false,
          value: undefined as AgentEvent | undefined,
          shuttingDown: true,
        }));
        const next = await Promise.race([iterator.next(), timeoutRace, leaseRace, cancelRace, shutdownRace]);
        timeoutSleep.cancel();
        if ((next as { cancelled?: boolean }).cancelled) {
          cancelled = true;
          await adapter.cancel(run.id);
          break;
        }
        if ((next as { shuttingDown?: boolean }).shuttingDown) {
          shuttingDown = true;
          // Cooperative stop: the agent is ended, and the run goes back to QUEUED in
          // finalize() so whoever starts next re-executes it.
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
        if (handled === 'cancelled') {
          cancelled = true;
          await adapter.cancel(run.id);
          break;
        }
      }

      // Shutting down: do not wait on the cancelled agent's exit, and do not record a
      // failure -- the run is being handed back, not abandoned (issue #51).
      if (shuttingDown) {
        return { status: 'SHUTDOWN', exit: { code: null, signal: 'SIGTERM', reason: 'terminated' } };
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
      // Must be unregistered or a stopped worker accumulates one resolver per run forever.
      this.shutdownSignals.delete(shutdown);
    }
  }

  /**
   * Handle one agent event. Returns 'lease-lost' if the lease was lost while
   * waiting for human input, 'input-timeout' if the wait exceeded the
   * configured input timeout, or 'cancelled' if the run was cancelled while
   * waiting (Mercury.md section 19).
   */
  private async handleAgentEvent(
    run: Run,
    adapter: AgentAdapter,
    ev: AgentEvent,
    skills: ResolvedSkill[],
    lost: LeaseLostSignal,
  ): Promise<'ok' | 'lease-lost' | 'input-timeout' | 'cancelled'> {
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
      if (outcome.kind === 'cancelled') {
        log.info({}, 'run cancelled while waiting for input');
        return 'cancelled';
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
    // Generic structured event passthrough.
    //
    // The old comment here read "(validated)" and nothing validated it. `ev.type` comes
    // from the adapter, so it is agent- and repository-controlled, and routes.ts writes
    // it raw into `event: <type>` in an SSE frame: a type containing a blank line injects
    // arbitrary frames into every subscriber of the run (issue #50).
    //
    // EventStore.append now rejects unknown types, which closes the injection for every
    // caller. Dropping here as well is deliberate, not redundant: append throwing would
    // propagate out of the drive loop uncaught, so a rogue agent could kill its own run
    // by emitting one odd event type. Reject at the choke point; discard at the boundary.
    if (!isEventType(ev.type)) {
      log.warn({ type: ev.type }, 'dropping agent event with an unknown type');
      return 'ok';
    }
    this.deps.events.append(run.id, ev.type, ev.payload);
    return 'ok';
  }

  /**
   * Poll for human input in arrival order (concurrent requests are presented
   * in order). Resolves with the input, or a marker if the lease was lost, the
   * input timeout (section 19) expired, or the run was cancelled while waiting.
   */
  private async waitForInput(runId: string, lost: LeaseLostSignal): Promise<
    | { kind: 'input'; input: AgentInput }
    | { kind: 'lease-lost' }
    | { kind: 'input-timeout' }
    | { kind: 'cancelled' }
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
      // Precedence within one poll window: an already-queued input wins over a
      // concurrent cancel; the input deadline wins over cancellation. Both are
      // defensible outcomes and the windows are small (inputPollMs).
      if (deadline !== null && Date.now() >= deadline) return { kind: 'input-timeout' };
      if (this.deps.runs.isCancellationRequested(runId)) return { kind: 'cancelled' };
      await Promise.race([sleep(this.deps.inputPollMs), lost.promise]);
      if (lost.fired) return { kind: 'lease-lost' };
      if (this.deps.runs.isCancellationRequested(runId)) return { kind: 'cancelled' };
    }
    throw new Error('Worker stopped while waiting for input');
  }

  private async finalize(
    run: Run,
    outcome: { status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'LEASE_LOST' | 'SHUTDOWN'; exit: AgentExit; error?: string; reason?: string },
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

    if (outcome.status === 'SHUTDOWN') {
      // Graceful shutdown (issue #51): hand the run back to the queue rather than failing it.
      // The alternative behaviours were both wrong -- leaving it RUNNING meant the lease
      // expired ~60s later and the reaper recorded FAILED(infrastructure) and auto-retried,
      // so every deploy turned in-flight work into spurious infrastructure failures and
      // duplicate agent spend; merely releasing the lease would have stranded the run in
      // RUNNING forever (see RunQueue.releaseLease).
      const requeued = this.deps.queue.requeueForShutdown(run.id, this.deps.workerId);
      // Branch on the result rather than logging 'requeued' with a boolean field next to it:
      // an operator reading shutdown logs greps the message, and a run that was NOT requeued
      // (lease taken concurrently, or the run went terminal) needs to be findable.
      if (requeued) {
        log.warn({ requeued: true }, 'worker shutting down; run requeued for the next worker');
      } else {
        log.warn({ status: current.status }, 'worker shutting down; run not requeueable, leaving it as is');
      }
      // No terminal event and no transition: the run is not finished, it is waiting again.
      // execute()'s finally still calls releaseLease, which is now a no-op here because the
      // run is QUEUED (non-terminal) and requeueForShutdown already cleared the lease.
      return;
    }

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
    const error = this.deps.redactor ? this.deps.redactor.redact(outcome.error ?? 'Agent failed') : (outcome.error ?? 'Agent failed');
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
    // Honor the per-run constraint (set at create time, defaulting to the global
    // config value); maxRetries = retries allowed after the initial attempt.
    const maxRetries = run.constraints.maxRetries;
    if (run.attempt > maxRetries) return;
    const log = this.logger(run.id);
    log.info({ attempt: run.attempt, maxRetries }, 'scheduling automatic retry');
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

/**
 * Copy resolved skills into the run workspace. Exported for tests: this is the WRITE side
 * of issue #58 and its guard needs a regression test of its own, rather than inheriting
 * coverage from the read side. (issue #58, review finding N1)
 */
export async function writeSkills(workspacePath: string, skills: ResolvedSkill[]): Promise<void> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const skillsRoot = join(workspacePath, '.agents', 'skills');
  for (const skill of skills) {
    // Both halves of the destination are contained (issue #58). skill.id used to be
    // interpolated straight into the path, so a resolved skill carrying a traversal id
    // would have been written anywhere the worker could write, not just into the
    // workspace. The registry now rejects such ids, but this is the write side and
    // should not depend on the read side having been correct.
    const skillDir = resolveContained(skillsRoot, assertSafeSkillId(skill.id));
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = resolveContained(skillDir, rel);
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
