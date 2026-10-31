// The Fleet scheduler client (FB2b, #973; docs/fleet-bots-design.md §4 option A, §6, §7).
//
// A bot whose config says `api.via: "fleet"` dispatches through Fleet instead of its own host. The
// scheduler does not change: `SchedulerClient` still has two calls, and this module implements
// them against Fleet's API (`POST /fleet/runs`, `GET /fleet/runs?owner=self`). Everything the
// scheduler relies on is preserved:
//
// - **Idempotency.** The bot's derived key travels as Fleet's `Idempotency-Key`; Fleet derives the
//   host key from it, so a crash between dispatch and state-write replays to the original Run.
//   Fleet answers 201 for a new binding and 200 when it replays one (§4) — both map to
//   `{ runId: fleetRunId, replayed }`.
// - **Single-flight.** `owner=self` scopes the list to THIS bot's bindings, so another caller's
//   non-terminal Run on the same host never blocks this bot's next fire.
// - **Unknown is non-terminal.** A binding whose `state` is null (Fleet could not reach the host,
//   or has not confirmed the binding yet) maps to status `UNKNOWN`. `scheduler.ts` treats any
//   status outside its terminal deny-list as non-terminal, so an UNKNOWN Run blocks the next fire —
//   the same rule a parked NEEDS_INPUT follows (§7).

import { readBotCredentials } from './credentials.ts';
import type { BotConfig } from './config.ts';
import { probeHealth } from './http.ts';
import type { BotRunView, DispatchRequest, SchedulerClient } from './scheduler.ts';

/**
 * The status Fleet reports for a binding it cannot resolve on the host (fleet/bindings.ts
 * UNKNOWN). Duplicated as a wire constant rather than imported: bot code talks HTTP and must not
 * import Fleet's internals (§15 item 4 of the bot design).
 */
export const FLEET_UNKNOWN = 'UNKNOWN';

/** The subset of Fleet's binding view this client reads. Extra fields are ignored. */
export interface FleetBindingView {
  fleetRunId: string;
  hostId?: string;
  ownerId?: string;
  childRunId?: string | null;
  requested?: Record<string, unknown>;
  createdAt?: string;
  state?: { status?: string | null } | null;
}

/**
 * Map one Fleet binding to the bot's own Run view.
 *
 * `constraints.botTask` comes from the `requested` payload Fleet stores verbatim (the bot sent it),
 * so the per-task single-flight count still works. A binding with no `requested` echo (corrupt
 * payload) simply carries no task name and is not counted — the scheduler skips nameless Runs,
 * exactly as it does for a host Run whose constraints are missing.
 */
export function bindingToBotRun(binding: FleetBindingView): BotRunView {
  const constraints = binding.requested?.constraints;
  const botTask = constraints !== null && typeof constraints === 'object'
    ? (constraints as Record<string, unknown>).botTask
    : undefined;
  return {
    id: binding.fleetRunId,
    status: binding.state?.status ?? FLEET_UNKNOWN,
    ...(typeof botTask === 'string' ? { constraints: { botTask } } : {}),
    ...(typeof binding.createdAt === 'string' ? { createdAt: binding.createdAt } : {}),
  };
}

export interface FleetClient extends SchedulerClient {
  baseUrl: string;
  probeHealth(): Promise<void>;
}

/**
 * Build the Fleet-bound client for one bot: the Fleet token from bot-credentials.json under the
 * bot's alias (§6), the Fleet base URL from `api.url`, and the same per-request deadline as the
 * host client.
 */
export function makeFleetClient(cfg: BotConfig, env: NodeJS.ProcessEnv = process.env): FleetClient {
  const token = readBotCredentials(cfg.alias, env).fleet;
  if (token === undefined || token === '') {
    // loadBotConfig already refuses this, so reaching it means a caller built a BotConfig by hand.
    // Fail loudly rather than fall back to the host token, which Fleet would reject anyway.
    throw new Error(`bot '${cfg.alias}': api.via 'fleet' needs a 'fleet' token in bot-credentials.json`);
  }
  const baseUrl = (cfg.api.url ?? `http://127.0.0.1:${env.MERCURY_PORT ?? 3000}`).replace(/\/$/, '');
  const timeoutMs = cfg.api.timeoutMs ?? 30_000;
  const headers = {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
  };
  async function call(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  return {
    baseUrl,
    probeHealth: () => probeHealth(baseUrl, timeoutMs),
    async listOwnRuns(limit = 200, cursor?: string | null): Promise<{ runs: BotRunView[]; nextCursor: string | null }> {
      // owner=self is the whole point of the FB2a change: the list is scoped to the caller's own
      // bindings server-side, never filtered client-side (a client filter would still ship another
      // caller's Runs over the wire).
      const cur = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await call(`/fleet/runs?owner=self&limit=${limit}${cur}`);
      if (!res.ok) throw new Error(`GET /fleet/runs answered ${res.status}`);
      const data = (await res.json()) as { runs?: FleetBindingView[]; nextCursor?: string | null };
      return {
        runs: (data.runs ?? []).map(bindingToBotRun),
        nextCursor: data.nextCursor ?? null,
      };
    },
    async createRun(req: DispatchRequest): Promise<{ runId: string; replayed: boolean }> {
      // The derived key is the ONLY correct idempotency value (§5.2), so a template that carries its
      // own `idempotency` field must not reach the wire: Fleet prefers a non-empty body
      // `idempotency` over the `Idempotency-Key` header (fleet/server.ts), and a static template
      // value would make every later fire replay the first binding instead of creating a Run. The
      // host path is immune because its route reads the header only, so stripping the field here
      // keeps the two dispatch targets identical.
      const { idempotency: _templateIdempotency, ...body } = req.body;
      const res = await call('/fleet/runs', {
        method: 'POST',
        headers: { 'idempotency-key': req.key },
        body: JSON.stringify(body),
      });
      // Exactly 201 (created) or 200 (replay). Anything else — 202/204 included — is refused before
      // res.json(), so a contract break cannot be read as a dispatch.
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`POST /fleet/runs answered ${res.status}`);
      }
      const data = (await res.json()) as { fleetRunId?: string };
      if (typeof data.fleetRunId !== 'string' || data.fleetRunId === '') {
        throw new Error('POST /fleet/runs answered without a fleetRunId');
      }
      return { runId: data.fleetRunId, replayed: res.status === 200 };
    },
  };
}
