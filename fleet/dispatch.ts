/**
 * Dispatch: submit a task to a named host and record the binding.
 *
 * Phase 1 of docs/fleet-design.md section 12. No routing -- the caller names the host. What this phase has to
 * prove is the binding model, idempotency across restarts, and crash recovery.
 *
 * The ordering is the whole design. A binding is written BEFORE the child is contacted, and the child call
 * carries an idempotency key derived from Fleet's own run id. So the dangerous interleaving -- child created
 * a Run, the response was lost -- resolves on the next attempt to the SAME child Run rather than to a second
 * one or to an orphan.
 */

import { randomUUID } from 'node:crypto';
import type { Binding, BindingStore } from './bindings.ts';
import { UNKNOWN } from './bindings.ts';
import type { ChildClient } from './child.ts';
import type { HostRegistry } from './registry.ts';

export class DispatchError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SubmitInput {
  hostId: string;
  /** The authenticated caller. Idempotency is scoped to it, so it cannot be taken from the body. */
  ownerId: string;
  /** The child payload, sent verbatim: task, repository, agent, constraints. */
  requested: Record<string, unknown>;
  clientToken?: string | null;
}

export interface SubmitOutcome {
  binding: Binding;
  /** True when an existing binding was returned instead of creating a second Run. */
  reused: boolean;
  /** True when the child's answer is still unknown; the binding is pending, not failed. */
  pending: boolean;
  note?: string;
}

export interface DispatchDeps {
  registry: HostRegistry;
  bindings: BindingStore;
  child: ChildClient;
  resolveToken: (credentialRef: string) => string;
}

function newFleetRunId(): string {
  // A distinct prefix from a child's run ids so an id is never ambiguous about which system issued it.
  return `fr_${randomUUID().replace(/-/g, '')}`;
}

/** Resolve a host the caller may use, or explain why not. */
export function resolveHost(deps: DispatchDeps, hostId: string): { baseUrl: string; token: string } {
  const host = deps.registry.get(hostId);
  if (!host) throw new DispatchError(404, `no such host: ${hostId}`);
  if (!host.enabled) {
    throw new DispatchError(409, `host ${hostId} is disabled; enable it before submitting work to it`);
  }
  return { baseUrl: host.baseUrl, token: deps.resolveToken(host.credentialRef) };
}

export async function submitRun(deps: DispatchDeps, input: SubmitInput): Promise<SubmitOutcome> {
  // Caller-level idempotency, checked before anything is written. This is what makes a retry after a
  // transport failure cheap: the same token returns the same binding, so no second child call happens and
  // no second Run is paid for.
  if (input.clientToken) {
    const existing = deps.bindings.findByClientToken(input.ownerId, input.clientToken);
    if (existing) {
      // Reuse is only correct if the caller means the same thing it meant the first time. Silently
      // returning a binding for a DIFFERENT host would suppress dispatch to the host the caller just named
      // and hand back a Run running somewhere else.
      if (existing.hostId !== input.hostId) {
        throw new DispatchError(
          409,
          `idempotency token was already used for host ${existing.hostId}, not ${input.hostId}. ` +
            `Reuse would return the existing Run rather than dispatch to the host you named; use a new token.`,
        );
      }
      return {
        binding: existing,
        reused: true,
        pending: existing.childRunId === null,
        // Accurate about WHEN this resolves: Phase 1 recovers at startup or on an explicit call. The
        // background sweep is Phase 2, and claiming otherwise here would send an operator to wait for
        // something that does not exist yet.
        note: existing.childRunId === null
          ? 'existing binding is still awaiting its child answer; it is resolved at Fleet startup or via a manual recovery'
          : undefined,
      };
    }
  }

  const host = resolveHost(deps, input.hostId);
  const fleetRunId = newFleetRunId();
  const binding = deps.bindings.createPending({
    fleetRunId,
    hostId: input.hostId,
    ownerId: input.ownerId,
    requested: input.requested,
    clientToken: input.clientToken ?? null,
  });

  const result = await deps.child.createRun(host, input.requested, fleetRunId);

  if (result.kind === 'ok') {
    const bound = deps.bindings.bind(fleetRunId, result.value.runId);
    deps.bindings.recordState({
      fleetRunId, status: result.value.status, cursor: 0,
      lastSeenAt: new Date().toISOString(), lastError: null,
    });
    return { binding: bound, reused: false, pending: false };
  }

  if (result.kind === 'rejected') {
    // A 4xx means the child refused and created nothing, so the binding is dead weight and removing it is
    // safe. This is the ONLY branch that discards.
    deps.bindings.discard(fleetRunId);
    throw new DispatchError(
      result.status === 404 ? 404 : 400,
      `host ${input.hostId} rejected the submission (HTTP ${result.status}${result.detail ? `: ${result.detail}` : ''})`,
    );
  }

  // Unknown: transport failure or 5xx. A Run may exist and be running right now. The binding stays, marked
  // UNKNOWN, and recovery resolves it later. Reporting failure here would be the section 7 mistake.
  deps.bindings.recordState({
    fleetRunId, status: UNKNOWN, cursor: 0,
    lastSeenAt: null, lastError: result.reason,
  });
  return {
    binding: deps.bindings.get(fleetRunId)!,
    reused: false,
    pending: true,
    note: `child answer unknown (${result.reason}); the Run may already exist and will be resolved on recovery`,
  };
}

/**
 * Crash recovery: re-derive every binding whose child answer was never recorded.
 *
 * Re-sends the stored payload with the SAME idempotency key. If the original request reached the child, the
 * child's dedupe returns the Run it already created; if it never arrived, this creates it. Either way Fleet
 * ends up able to name the Run, which is the point of the table.
 */
export async function recoverPending(deps: DispatchDeps): Promise<{ resolved: number; stillPending: number }> {
  const pending = deps.bindings.pending();
  let resolved = 0;
  for (const binding of pending) {
    let host: { baseUrl: string; token: string };
    try {
      host = resolveHost(deps, binding.hostId);
    } catch {
      // Host removed or disabled since the binding was made. Leave it pending: deleting the binding here is
      // exactly the orphaning this function exists to prevent.
      continue;
    }
    const result = await deps.child.createRun(host, binding.requested, binding.fleetRunId);
    if (result.kind === 'ok') {
      deps.bindings.bind(binding.fleetRunId, result.value.runId);
      deps.bindings.recordState({
        fleetRunId: binding.fleetRunId, status: result.value.status, cursor: 0,
        lastSeenAt: new Date().toISOString(), lastError: null,
      });
      resolved++;
      continue;
    }
    if (result.kind === 'rejected') {
      // The child says it never had this key and refuses the payload now. Nothing is running.
      deps.bindings.discard(binding.fleetRunId);
      continue;
    }
    deps.bindings.recordState({
      fleetRunId: binding.fleetRunId, status: UNKNOWN, cursor: 0,
      lastSeenAt: null, lastError: result.reason,
    });
  }
  return { resolved, stillPending: deps.bindings.pending().length };
}

/** Refresh cached status for every bound Run the caller can see. */
export async function refreshStates(deps: DispatchDeps, hostIds: '*' | string[]): Promise<number> {
  const views = deps.bindings.list(hostIds);
  let updated = 0;
  for (const view of views) {
    if (!view.childRunId) continue;
    let host: { baseUrl: string; token: string };
    try {
      host = resolveHost(deps, view.hostId);
    } catch {
      continue;
    }
    const result = await deps.child.getRun(host, view.childRunId);
    if (result.kind === 'ok') {
      deps.bindings.recordState({
        fleetRunId: view.fleetRunId, status: result.value.status,
        cursor: view.state?.cursor ?? 0,
        lastSeenAt: new Date().toISOString(), lastError: result.value.error ?? null,
      });
      updated++;
    } else {
      // Unreachable is not failed. Keep the last known status but record why it may be stale.
      deps.bindings.recordState({
        fleetRunId: view.fleetRunId,
        status: view.state?.status ?? UNKNOWN,
        cursor: view.state?.cursor ?? 0,
        lastSeenAt: view.state?.lastSeenAt ?? null,
        lastError: result.kind === 'unknown' ? result.reason : `child said HTTP ${result.status}`,
      });
    }
  }
  return updated;
}
