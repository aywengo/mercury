// The doctor's bots section (docs/dispatcher-bot-design.md §13; B4, issue #915).
//
// One line per configured bot, from the same facts the operator's other commands use:
//
//   - the config parses and validates (loadBotConfig, B0-5);
//   - the credentials file is private and has this alias's entry (readBotCredentials, 0600 gate);
//   - the two token copies agree: the credentials token is registered for owner `bot-<alias>` in
//     MERCURY_API_TOKENS (§4.2);
//   - the state file is writable (or its nearest existing directory is, before the first tick);
//   - the next fire is computable from config + cron;
//   - the bounded, read-only status view answers with this bot's own token (§11).
//
// Every check is bounded and fail-closed: an invalid bot is a FAIL line with the reason the
// validator/API gave, never a crash and never a silent pass. The doctor exits non-zero when any
// configured bot fails (acceptance: a seeded defect must fail the command, with a named reason).

import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { botsDir, loadBotConfig } from './config.ts';
import { botCredentialsPath, readBotCredentials, registeredOwnerForToken } from './credentials.ts';
import { botOwnerId } from './keys.ts';
import { botStatePath, makeBotClient } from './process.ts';
import { nextFires, statusView, type StatusView } from './status.ts';
import type { BotConfig } from './config.ts';
import type { SchedulerClient } from './scheduler.ts';

/** One bot's verdict, rendered as `bot <alias>: PASS|FAIL — <detail>`. */
export interface BotDoctorLine {
  alias: string;
  ok: boolean;
  detail: string;
}

export interface BotsDoctorResult {
  ok: boolean;
  bots: BotDoctorLine[];
  /** The mercury.env permission note (§4.2: it holds tokens and is expected to be 0600). */
  envFileMode?: { ok: boolean; detail: string };
}

/** Configured aliases: `<alias>.json` files in the bots directory, sorted, dotfiles ignored. */
export function discoverBotAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  let entries: string[];
  try {
    entries = readdirSync(botsDir(env));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.json') && !entry.startsWith('.'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
}

/**
 * Can the bot write its state file? A fresh bot has none yet (it is written on the first tick), so
 * check the nearest existing ancestor directory instead of creating anything. Read-only.
 */
export function stateFileWritable(path: string): { ok: boolean; detail: string } {
  try {
    if (existsSync(path)) {
      if (!statSync(path).isFile()) return { ok: false, detail: `${path} exists but is not a file` };
      accessSync(path, constants.W_OK);
      return { ok: true, detail: 'state file writable' };
    }
    let dir = dirname(path);
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    accessSync(dir, constants.W_OK);
    return { ok: true, detail: 'state directory writable (no state file yet)' };
  } catch (err) {
    return { ok: false, detail: `${path} is not writable: ${(err as Error).message}` };
  }
}

function formatGap(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

/** The next fire across all tasks, or a line saying nothing fires in the 24h horizon. */
function nextFireDetail(cfg: BotConfig, nowMs: number): string {
  const upcoming = nextFires(cfg, nowMs).filter((f) => Number.isFinite(f.fireMs)).sort((a, b) => a.fireMs - b.fireMs);
  if (upcoming.length === 0) return 'no task fires within 24h';
  const next = upcoming[0]!;
  return `next ${next.task} in ${formatGap(next.fireMs - nowMs)}`;
}

function lastActionDetail(view: StatusView): string {
  const last = view.lastActions[0];
  if (!last) return 'no Runs yet';
  return `last action ${last.id} task=${last.task ?? '-'} ${last.status}, dispatches last hour: ${view.dispatchesLastHour}`;
}

/** `GET /api/runs answered 401` is the design's token-rejected line, not a generic outage. */
function apiFailureDetail(raw: string): string {
  // statusView prefixes the error name (`Error: fetch failed`); the operator needs the cause.
  const message = raw.replace(/^\w*Error: /, '');
  return /\b401\b/.test(message)
    ? 'token rejected (401); check bot-credentials.json'
    : `status unavailable: ${message}`;
}

export interface CheckBotsOptions {
  env?: NodeJS.ProcessEnv;
  /** The mercury.env values (the file the service reads). */
  vars: Record<string, string | undefined>;
  nowMs?: number;
  /** Test seam: one bot's read-only client. Default: the real one, with a 10 s request cap. */
  clientFor?: (cfg: BotConfig) => SchedulerClient;
  /** The mercury.env path, for the permission note. Default: the wizard's path. */
  envFilePath?: string;
}

/** Check every configured bot. Returns one line per alias plus the env-file permission note. */
export async function checkBots(opts: CheckBotsOptions): Promise<BotsDoctorResult> {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  const aliases = discoverBotAliases(env);
  if (aliases.length === 0) return { ok: true, bots: [] };
  const apiTokens = opts.vars.MERCURY_API_TOKENS ?? env.MERCURY_API_TOKENS;
  const bots: BotDoctorLine[] = [];
  for (const alias of aliases) {
    bots.push(await checkOne(alias, { ...opts, env, nowMs, apiTokens }));
  }
  let envFileMode: BotsDoctorResult['envFileMode'];
  const envFile = opts.envFilePath;
  if (envFile !== undefined && existsSync(envFile)) {
    const mode = statSync(envFile).mode & 0o777;
    const readable = (mode & 0o077) !== 0;
    envFileMode = readable
      ? { ok: false, detail: `${envFile} is readable by group or others (mode ${mode.toString(8).padStart(3, '0')}); chmod 600 — it holds API tokens` }
      : { ok: true, detail: `${envFile} is mode ${mode.toString(8).padStart(3, '0')}` };
  }
  return {
    ok: bots.every((b) => b.ok) && (envFileMode?.ok ?? true),
    bots,
    ...(envFileMode ? { envFileMode } : {}),
  };
}

async function checkOne(
  alias: string,
  opts: CheckBotsOptions & { env: NodeJS.ProcessEnv; nowMs: number; apiTokens: string | undefined },
): Promise<BotDoctorLine> {
  let cfg: BotConfig;
  try {
    cfg = loadBotConfig(alias, opts.env);
  } catch (err) {
    return { alias, ok: false, detail: `config invalid: ${(err as Error).message}` };
  }
  let token: string;
  try {
    token = readBotCredentials(alias, opts.env).api!;
  } catch (err) {
    return { alias, ok: false, detail: `credentials: ${(err as Error).message}` };
  }
  let owner: string | null;
  try {
    owner = registeredOwnerForToken(token, opts.apiTokens);
  } catch (err) {
    return { alias, ok: false, detail: `agreement: ${(err as Error).message}` };
  }
  const expected = botOwnerId(alias);
  if (owner === null) {
    return { alias, ok: false, detail: `token in ${botCredentialsPath(opts.env)} is not registered in MERCURY_API_TOKENS (expected owner '${expected}')` };
  }
  if (owner !== expected) {
    return { alias, ok: false, detail: `token is registered as owner '${owner}', expected '${expected}'` };
  }
  const writable = stateFileWritable(botStatePath(alias, opts.env));
  if (!writable.ok) return { alias, ok: false, detail: `state: ${writable.detail}` };
  let view: StatusView;
  try {
    const client = opts.clientFor
      ? opts.clientFor(cfg)
      : makeBotClient({ ...cfg, api: { ...cfg.api, timeoutMs: Math.min(cfg.api.timeoutMs ?? 30_000, 10_000) } }, opts.env);
    view = await statusView(cfg, client, opts.nowMs);
  } catch (err) {
    return { alias, ok: false, detail: apiFailureDetail(err instanceof Error ? err.message : String(err)) };
  }
  if (view.apiError !== undefined) return { alias, ok: false, detail: apiFailureDetail(view.apiError) };
  const tasks = `${cfg.tasks.length} task${cfg.tasks.length === 1 ? '' : 's'}`;
  return {
    alias,
    ok: true,
    detail: `config ok, token ok, ${tasks}, ${nextFireDetail(cfg, opts.nowMs)}, ${lastActionDetail(view)}`,
  };
}
