import type { Binding } from './bindings.ts';
import { DispatchError, resolveHost, type DispatchDeps } from './dispatch.ts';

/**
 * Interaction through Fleet (docs/fleet-design.md section 12, Phase 5): input, cancel, retry.
 *
 * Section 7's rule still governs here. A transport failure on a cancel is not evidence the Run is cancelled,
 * and claiming otherwise would let an operator walk away from a Run that is still running and spending money.
 * Every verb therefore distinguishes a child refusal from an answer we do not have.
 */

/** Interaction needs no database of its own; it reads bindings and talks to children. */
export type InteractionDeps = DispatchDeps;

export interface InteractionOutcome {
  fleetRunId: string;
  hostId: string;
  childRunId: string | null;
  /** Status reported by the child, when it answered. */
  status: string | null;
  /** True when the child could not be reached or 5xx'd: the action may or may not have happened. */
  unknown: boolean;
  note?: string;
}

function requireBound(deps: DispatchDeps, fleetRunId: string): { binding: Binding; host: { baseUrl: string; token: string } } {
  const binding = deps.bindings.get(fleetRunId);
  if (!binding) throw new DispatchError(404, `no Fleet Run ${fleetRunId}`);
  if (!binding.childRunId) {
    // Nothing exists on the child yet, so there is nothing to talk to. This is not a failure of the action.
    throw new DispatchError(409,
      `Fleet Run ${fleetRunId} has no child Run yet; its dispatch is still unresolved`);
  }
  return { binding, host: resolveHost(deps, binding.hostId) };
}

/**
 * A child refusal is the caller's problem to see, so it surfaces as a 400 carrying the child's own reason.
 *
 * Only refusals go through here. An unreachable child is NOT an error and never was: it returns an outcome with
 * unknown set, because throwing would invite someone to map it to a status that implies the action failed.
 */
function refuse(detail: string): never {
  throw new DispatchError(400, detail);
}

export async function sendInput(deps: DispatchDeps, fleetRunId: string, input: unknown): Promise<InteractionOutcome> {
  const { binding, host } = requireBound(deps, fleetRunId);
  const res = await deps.child.submitInput(host, binding.childRunId!, input);
  if (res.kind === 'rejected') refuse(`child refused input: ${res.detail}`);
  if (res.kind === 'unknown') {
    return {
      fleetRunId, hostId: binding.hostId, childRunId: binding.childRunId, status: null, unknown: true,
      note: `input delivery unconfirmed (${res.reason}); the Run may still have received it`,
    };
  }
  return { fleetRunId, hostId: binding.hostId, childRunId: binding.childRunId, status: null, unknown: false };
}

export async function cancelRun(deps: DispatchDeps, fleetRunId: string): Promise<InteractionOutcome> {
  const { binding, host } = requireBound(deps, fleetRunId);
  const res = await deps.child.cancelRun(host, binding.childRunId!);
  if (res.kind === 'rejected') refuse(`child refused cancel: ${res.detail}`);
  if (res.kind === 'unknown') {
    // Deliberately not recorded as CANCELLED. Reconciliation will read the real status on the next pass.
    return {
      fleetRunId, hostId: binding.hostId, childRunId: binding.childRunId, status: null, unknown: true,
      note: `cancel unconfirmed (${res.reason}); status will be corrected by reconciliation`,
    };
  }
  // The child answered, so record what it said rather than the status we hoped for.
  deps.bindings.recordState({
    fleetRunId, status: res.value.status, cursor: deps.bindings.state(fleetRunId)?.cursor ?? 0,
    lastSeenAt: new Date().toISOString(), lastError: null,
  });
  return {
    fleetRunId, hostId: binding.hostId, childRunId: binding.childRunId,
    status: res.value.status, unknown: false,
  };
}

/**
 * Retry, and follow the binding to the new child Run.
 *
 * Mercury's retry creates a NEW Run (it answers a fresh runId plus retryOf). The binding must move with it or
 * Fleet would keep polling a Run the operator has superseded -- and the mirrored window has to be cleared,
 * because it is keyed on the child's sequence and the new Run restarts at 1.
 */
export async function retryRun(deps: DispatchDeps, fleetRunId: string): Promise<InteractionOutcome> {
  const { binding, host } = requireBound(deps, fleetRunId);
  const previousChildRunId = binding.childRunId!;
  const res = await deps.child.retryRun(host, previousChildRunId);
  if (res.kind === 'rejected') refuse(`child refused retry: ${res.detail}`);
  if (res.kind === 'unknown') {
    // A retry that we cannot confirm is the dangerous case: the child may have created a Run that Fleet does
    // not know about. Say so plainly rather than leaving the binding silently pointing at the old Run.
    return {
      fleetRunId, hostId: binding.hostId, childRunId: previousChildRunId, status: null, unknown: true,
      note: `retry unconfirmed (${res.reason}); a child Run may exist that Fleet has not bound. `
        + 'Re-submit with a new idempotency key only after checking the host.',
    };
  }
  const rebound = deps.bindings.rebind(fleetRunId, res.value.runId);
  deps.bindings.recordState({
    fleetRunId, status: res.value.status, cursor: 0,
    lastSeenAt: new Date().toISOString(), lastError: null,
  });
  return {
    fleetRunId, hostId: rebound.hostId, childRunId: res.value.runId,
    status: res.value.status, unknown: false,
    note: `retried: child Run ${previousChildRunId} superseded by ${res.value.runId}`,
  };
}
