// The bot process layer (docs/dispatcher-bot-design.md §5.3, §10; B1-1, issue #735).
//
// `mercury host bot run --alias <a>`: load one config, probe /healthz with capped backoff
// (5 attempts, 15 s cap — the same bounds the CLI's stream uses), then tick once per minute.
// SIGINT/SIGTERM stop the timer and exit 0; an in-flight dispatch finishes first because the
// idempotency key makes a repeated dispatch safe, and the bot never cancels a Run on shutdown.
//
// State file: ${XDG_STATE_HOME:-~/.local/state}/mercury/bots/<alias>.state.json (0600), written
// after every completed tick (dispatch or not). It records lastTickMs so a restart can evaluate
// onMiss; the file is an optimisation — non-double-dispatch comes from the derived key, never
// from the file (§5.3).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBotConfig, type BotConfig } from './config.ts';
import { readBotCredentials } from './credentials.ts';
import { makeFleetClient } from './fleetClient.ts';
import { probeHealth } from './http.ts';
import { tick, type SchedulerClient, type BotRunView, type DispatchRequest } from './scheduler.ts';

const TICK_MS = 60_000;

export function botStatePath(alias: string, env: NodeJS.ProcessEnv = process.env): string {
  // Same alias vocabulary as the config loader — these helpers are exported, so an unvalidated
  // alias here would be a path-traversal hole ('../x' escapes the bots dir).
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) {
    throw new Error(`bot alias must match ^[a-z][a-z0-9-]{0,31}$, got '${alias}'`);
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'mercury', 'bots', `${alias}.state.json`);
}

export function readBotState(alias: string, env: NodeJS.ProcessEnv = process.env): { lastTickMs?: number } {
  const path = botStatePath(alias, env);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { lastTickMs?: number };
    if (typeof raw.lastTickMs === 'number' && Number.isFinite(raw.lastTickMs)) {
      return { lastTickMs: raw.lastTickMs };
    }
    return {};
  } catch {
    return {}; // absent or unreadable state = no onMiss window; correctness never leans on it
  }
}

export function writeBotState(alias: string, state: { lastTickMs: number }, env: NodeJS.ProcessEnv = process.env): void {
  const path = botStatePath(alias, env);
  mkdirSync(join(path, '..'), { recursive: true });
  // mode 0600 at create; an existing file keeps its mode, which validate/doctor check.
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

/** HTTP client bound to one bot identity: the token from bot-credentials.json, owner bot-<alias>. */
export function makeBotClient(cfg: BotConfig, env: NodeJS.ProcessEnv = process.env): SchedulerClient & { baseUrl: string; probeHealth(): Promise<void> } {
  const creds = readBotCredentials(cfg.alias, env);
  const token = creds.api!;
  const baseUrl = (cfg.api.url ?? `http://127.0.0.1:${env.MERCURY_PORT ?? 3000}`).replace(/\/$/, '');
  const timeoutMs = cfg.api.timeoutMs ?? 30_000;
  const headers = {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
  };
  async function call(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  }
  return {
    baseUrl,
    // Capped backoff: 5 attempts, 15 s cap (§10 start ordering). Shared with the Fleet client.
    probeHealth: () => probeHealth(baseUrl, timeoutMs),
    async listOwnRuns(limit = 200, cursor?: string | null): Promise<{ runs: BotRunView[]; nextCursor: string | null }> {
      const cur = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await call(`/api/runs?limit=${limit}${cur}`);
      if (!res.ok) throw new Error(`GET /api/runs answered ${res.status}`);
      const data = (await res.json()) as { runs: BotRunView[]; nextCursor: string | null };
      return { runs: data.runs ?? [], nextCursor: data.nextCursor ?? null };
    },
    async createRun(req: DispatchRequest): Promise<{ runId: string; replayed: boolean }> {
      const res = await call('/api/runs', {
        method: 'POST',
        headers: { 'idempotency-key': req.key },
        body: JSON.stringify(req.body),
      });
      // The §5.2 contract is EXACTLY 201 (created) or 200 (replay). Anything else — 202/204 included
      // — would parse garbage or hide a contract break, so it is refused before res.json().
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`POST /api/runs answered ${res.status}`);
      }
      const data = (await res.json()) as { runId: string };
      return { runId: data.runId, replayed: res.status === 200 };
    },
  };
}

/**
 * The scheduler client this bot's config asks for (FB2b, #973).
 *
 * `api.via: "fleet"` dispatches through Fleet; everything else — including a config that never
 * mentions `via` — uses the host client unchanged. The two clients are interchangeable because
 * they implement the same two-call `SchedulerClient`, which is what makes option A a small change
 * (docs/fleet-bots-design.md §4).
 */
export function makeSchedulerClient(
  cfg: BotConfig,
  env: NodeJS.ProcessEnv = process.env,
): SchedulerClient & { baseUrl: string; probeHealth(): Promise<void> } {
  return cfg.api.via === 'fleet' ? makeFleetClient(cfg, env) : makeBotClient(cfg, env);
}

export interface RunBotOptions {
  now?: () => number;
  tickFn?: typeof tick;
  /** Test hook: run exactly one tick then return instead of looping forever. */
  once?: boolean;
  log?: (line: string) => void;
}

/** Run the bot until signalled (or one tick with `once`). Returns the process exit code. */
export async function runBot(alias: string, env: NodeJS.ProcessEnv = process.env, opts: RunBotOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => Date.now());
  const tickFn = opts.tickFn ?? tick;
  const cfg = loadBotConfig(alias, env);
  const client = makeSchedulerClient(cfg, env);
  await client.probeHealth();
  log(`bot=${alias} api=${client.baseUrl} via=${cfg.api.via ?? 'host'} tasks=${cfg.tasks.length} healthz ok`);
  for (const w of cfg.warnings) log(`bot=${alias} config warn: ${w}`);
  let stopping = false;
  let exitCode = 0;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    log(`bot=${alias} shutdown: stopping timers (Runs are never cancelled by a bot)`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let lastTickMs = readBotState(alias, env).lastTickMs ?? now();
  try {
    do {
      const nowMs = now();
      const outcome = await tickFn(cfg, client, { nowMs, afterMs: lastTickMs });
      for (const d of outcome.dispatched) {
        log(`bot=${alias} task=${d.task} fire=${new Date(d.fireMs).toISOString()} run=${d.runId}${d.replayed ? ' (replayed)' : ''}`);
      }
      for (const s of outcome.skippedSingleFlight) {
        log(`bot=${alias} task=${s.task} fire=${new Date(s.fireMs).toISOString()} skipped: previous Run non-terminal (singleFlight)`);
      }
      for (const s of outcome.skippedMissed) {
        log(`bot=${alias} task=${s.task} fire=${new Date(s.fireMs).toISOString()} skipped: ${s.reason}`);
      }
      for (const e of outcome.errors) {
        log(`bot=${alias} task=${e.task} fire=${new Date(e.fireMs).toISOString()} ERROR: ${e.message}`);
      }
      lastTickMs = nowMs;
      writeBotState(alias, { lastTickMs }, env);
      if (opts.once) break;
      // Sleep in short slices so a signal stops the timer promptly without killing an in-flight
      // dispatch (the tick above is already complete here).
      const wakeAt = now() + TICK_MS;
      while (!stopping && now() < wakeAt) {
        await new Promise((r) => setTimeout(r, Math.min(250, wakeAt - now())));
      }
    } while (!stopping);
  } catch (err) {
    log(`bot=${alias} fatal: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    exitCode = 1;
  }
  log(`bot=${alias} exit ${exitCode}`);
  return exitCode;
}
