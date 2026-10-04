// Bot config loading and validation (docs/dispatcher-bot-design.md §4.1, §12).
//
// One JSON file per bot at ${XDG_CONFIG_HOME:-~/.config}/mercury/bots/<alias>.json. The alias is
// the file name, so it must be filesystem-, systemd- and log-safe. Validation refuses unknown keys
// (with a did-you-mean suggestion) because a typoed key would otherwise silently disable the guard
// it was meant to configure -- the same rule the wizard's answers file follows (#649 §2) and the
// remote-agent registry follows for the same reason.
//
// `triggers` and `brain` are RESERVED: the schema accepts their presence but refuses them with a
// "not supported before B2/B3" error, so a config cannot claim behaviour the bot does not have.
// B1 runs schedule-only bots.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCron, parseTz } from './cron.ts';

/** The alias regex (§4.1): filesystem-safe, systemd-unit-safe, stable in log lines and owner ids. */
export const BOT_ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Aliases the host reserves for non-bot credentials. `laya` keys the sidecar's shared
 *  bot-credentials.json entry (#831); a bot with that alias would have its Mercury API token
 *  read as the sidecar key, and `host bot uninstall --alias laya` would delete the sidecar's
 *  credential out from under a configured sidecar (Copilot #840 r31). */
export const RESERVED_BOT_ALIASES: ReadonlySet<string> = new Set(['laya']);

/** Task names appear in derived idempotency keys (colon-delimited) and log lines. */
const TASK_NAME_RE = /^[a-z0-9-]+$/;

const ON_MISS_VALUES = ['skip', 'collapse', 'run'] as const;

/** Top-level keys the v1 schema knows. `triggers`/`brain` are known but reserved (see below). */
const TOP_LEVEL_KEYS = [
  'description', 'api', 'schedule', 'triggers', 'brain',
] as const;

const API_KEYS = ['url', 'timeoutMs'] as const;

const TASK_KEYS = [
  'name', 'cron', 'tz', 'template', 'singleFlight', 'onMiss', 'maxCatchUp', 'select',
] as const;

/** `select` shape validation constants (docs/laya-integration-design.md §6.3, §10): 1-12
 *  candidates, mode shadow|enforce, minConfidence in (0,1) exclusive. Validated BEFORE the
 *  reserved refusal so a config written today is accepted by L1 unchanged (#826). */
const SELECT_MODES = ['shadow', 'enforce'] as const;
const MAX_SELECT_CANDIDATES = 12;

/**
 * Nearest known key, for the unknown-key refusal. A small local levenshtein instead of an import:
 * the bot boundary test (§15 item 4) pins bot code to the API surface plus the redactor, so a
 * 15-line edit-distance here is cheaper than a dependency that would fail the guard.
 */
function suggestionFor(key: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[a.length][b.length];
  };
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Same cap the config schema uses: past ~3 edits it is a different key, not a typo.
  if (best === undefined || bestDistance > Math.max(2, Math.floor(best.length / 4))) return undefined;
  return best;
}

function refuse(path: string, field: string, message: string): never {
  throw new Error(`${path}: ${field}: ${message}`);
}

function refuseUnknown(path: string, field: string, key: string, known: readonly string[]): never {
  const s = suggestionFor(key, known);
  refuse(path, field, `unknown key '${key}'${s ? ` (did you mean '${s}'?)` : ''}`);
}

export interface BotTaskConfig {
  name: string;
  cron: string;
  tz?: string;
  template: Record<string, unknown>;
  singleFlight: boolean;
  onMiss: 'skip' | 'collapse' | 'run';
  maxCatchUp?: number;
}

export interface BotConfig {
  alias: string;
  description?: string;
  api: { url?: string; timeoutMs?: number };
  tasks: BotTaskConfig[];
  /** Human-readable findings that do not block use (e.g. the `run` + `singleFlight` warning). */
  warnings: string[];
}

/** The bots directory for this host (§4.1). */
export function botsDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'mercury', 'bots');
  return join(homedir(), '.config', 'mercury', 'bots');
}

export function botConfigPath(alias: string, env: NodeJS.ProcessEnv = process.env): string {
  assertBotAlias(alias);
  return join(botsDir(env), `${alias}.json`);
}

/** The §4.1 alias contract plus the host's reserved names. Every bot lifecycle path
 *  (config parse, service install/uninstall) funnels through here. */
export function assertBotAlias(alias: string): void {
  if (!BOT_ALIAS_RE.test(alias)) {
    throw new Error(`bot alias must match ${BOT_ALIAS_RE.source}, got '${alias}'`);
  }
  if (RESERVED_BOT_ALIASES.has(alias)) {
    throw new Error(`bot alias '${alias}' is reserved for the host (the Laya sidecar credential entry); pick another name`);
  }
}

function checkObject(path: string, field: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(path, field, 'must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function validateTask(path: string, raw: Record<string, unknown>, index: number, seen: Set<string>): BotTaskConfig {
  const field = `schedule.tasks[${index}]`;
  for (const key of Object.keys(raw)) {
    if (!(TASK_KEYS as readonly string[]).includes(key)) refuseUnknown(path, field, key, TASK_KEYS);
  }
  const name = raw.name;
  if (typeof name !== 'string' || !TASK_NAME_RE.test(name)) {
    refuse(path, `${field}.name`, `must match ${TASK_NAME_RE.source}`);
  }
  if (seen.has(name)) refuse(path, `${field}.name`, `duplicate task name '${name}' (names are unique per bot)`);
  seen.add(name);
  if (typeof raw.cron !== 'string' || raw.cron.trim() === '') {
    refuse(path, `${field}.cron`, 'must be a 5-field cron string');
  }
  // Parse here so a bad expression fails at validate time with a named field, not at 03:00.
  try {
    parseCron(raw.cron as string);
  } catch (err) {
    refuse(path, `${field}.cron`, (err as Error).message);
  }
  if (raw.tz !== undefined) {
    if (typeof raw.tz !== 'string') refuse(path, `${field}.tz`, 'must be a string');
    try {
      parseTz(raw.tz);
    } catch (err) {
      refuse(path, `${field}.tz`, (err as Error).message);
    }
  }
  const template = checkObject(path, `${field}.template`, raw.template);
  if (typeof template.task !== 'string' || (template.task as string).trim() === '') {
    refuse(path, `${field}.template.task`, 'must be a non-empty string (the Run task text)');
  }
  const singleFlight = raw.singleFlight === undefined ? true : raw.singleFlight;
  if (typeof singleFlight !== 'boolean') refuse(path, `${field}.singleFlight`, 'must be a boolean');
  const onMiss = raw.onMiss === undefined ? 'skip' : raw.onMiss;
  if (typeof onMiss !== 'string' || !(ON_MISS_VALUES as readonly string[]).includes(onMiss)) {
    refuse(path, `${field}.onMiss`, `must be one of ${ON_MISS_VALUES.join(', ')}`);
  }
  let maxCatchUp: number | undefined;
  if (raw.maxCatchUp !== undefined) {
    if (typeof raw.maxCatchUp !== 'number' || !Number.isInteger(raw.maxCatchUp) || raw.maxCatchUp < 0) {
      refuse(path, `${field}.maxCatchUp`, 'must be a non-negative integer');
    }
    maxCatchUp = raw.maxCatchUp as number;
  }
  // `select` is RESERVED before L1 (#826), but its SHAPE is validated first: a well-formed block
  // gets the reserved message; a malformed one gets the shape error first, so a config written
  // today is accepted by L1 unchanged once the refusal is lifted.
  if (raw.select !== undefined) {
    const select = checkObject(path, `${field}.select`, raw.select);
    const selectKeys = ['via', 'mode', 'minConfidence', 'candidates'];
    for (const key of Object.keys(select)) {
      if (!selectKeys.includes(key)) refuseUnknown(path, `${field}.select`, key, selectKeys);
    }
    if (select.via !== 'laya') {
      refuse(path, `${field}.select.via`, "must be 'laya' (the only v1 via)");
    }
    if (select.mode !== undefined && (typeof select.mode !== 'string' || !(SELECT_MODES as readonly string[]).includes(select.mode))) {
      refuse(path, `${field}.select.mode`, `must be one of ${SELECT_MODES.join(', ')}`);
    }
    if (select.mode === 'enforce' && select.minConfidence === undefined) {
      refuse(path, `${field}.select.minConfidence`, 'required when mode is enforce');
    }
    if (select.minConfidence !== undefined) {
      const mc = select.minConfidence;
      if (typeof mc !== 'number' || !Number.isFinite(mc) || mc <= 0 || mc >= 1) {
        refuse(path, `${field}.select.minConfidence`, 'must be a number in (0, 1) exclusive');
      }
    }
    if (!Array.isArray(select.candidates) || select.candidates.length === 0) {
      refuse(path, `${field}.select.candidates`, `must be a non-empty array of 1-${MAX_SELECT_CANDIDATES} candidate objects`);
    }
    if (Array.isArray(select.candidates) && select.candidates.length > MAX_SELECT_CANDIDATES) {
      refuse(path, `${field}.select.candidates`, `must have at most ${MAX_SELECT_CANDIDATES} candidates (§6.3: options share a fixed token budget)`);
    }
    if (Array.isArray(select.candidates)) {
      select.candidates.forEach((cand, ci) => {
        const cfield = `${field}.select.candidates[${ci}]`;
        const candObj = checkObject(path, cfield, cand);
        const candKeys = ['agent', 'model', 'describe'];
        for (const key of Object.keys(candObj)) {
          if (!candKeys.includes(key)) refuseUnknown(path, cfield, key, candKeys);
        }
        if (typeof candObj.agent !== 'string' || (candObj.agent as string).trim() === '') {
          refuse(path, `${cfield}.agent`, 'must be a non-empty string');
        }
        if (candObj.model !== undefined && (typeof candObj.model !== 'string' || (candObj.model as string).trim() === '')) {
          refuse(path, `${cfield}.model`, 'must be a non-empty string when present');
        }
        if (typeof candObj.describe !== 'string' || (candObj.describe as string).trim() === '') {
          refuse(path, `${cfield}.describe`, 'must be a non-empty string');
        }
      });
    }
    refuse(path, `${field}.select`, 'reserved: select is not supported before L1');
  }
  return {
    name,
    cron: raw.cron as string,
    ...(raw.tz !== undefined ? { tz: raw.tz as string } : {}),
    template,
    singleFlight,
    onMiss: onMiss as BotTaskConfig['onMiss'],
    ...(maxCatchUp !== undefined ? { maxCatchUp } : {}),
  };
}

/** Load and validate one bot config by alias. Throws with a named field on any problem. */
export function loadBotConfig(alias: string, env: NodeJS.ProcessEnv = process.env): BotConfig {
  // botConfigPath validates the alias (the same regex the caller-visible name obeys), so no
  // second check here.
  const path = botConfigPath(alias, env);
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read bot config ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`${path}: not valid JSON: ${(err as Error).message}`);
  }
  const root = checkObject(path, '(root)', raw);
  for (const key of Object.keys(root)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) refuseUnknown(path, '(root)', key, TOP_LEVEL_KEYS);
  }
  if (root.triggers !== undefined) {
    refuse(path, 'triggers', 'reserved: triggers are not supported before B2');
  }
  if (root.brain !== undefined) {
    refuse(path, 'brain', 'reserved: the brain is not supported before B3');
  }
  let description: string | undefined;
  if (root.description !== undefined) {
    if (typeof root.description !== 'string') refuse(path, 'description', 'must be a string');
    description = root.description as string;
  }
  let api: { url?: string; timeoutMs?: number } = {};
  if (root.api !== undefined) {
    const apiRaw = checkObject(path, 'api', root.api);
    for (const key of Object.keys(apiRaw)) {
      if (!(API_KEYS as readonly string[]).includes(key)) refuseUnknown(path, 'api', key, API_KEYS);
    }
    if (apiRaw.url !== undefined) {
      if (typeof apiRaw.url !== 'string' || !/^https?:\/\//.test(apiRaw.url as string)) {
        refuse(path, 'api.url', 'must be an http(s) URL');
      }
      api.url = apiRaw.url as string;
    }
    if (apiRaw.timeoutMs !== undefined) {
      if (typeof apiRaw.timeoutMs !== 'number' || !Number.isInteger(apiRaw.timeoutMs) || (apiRaw.timeoutMs as number) <= 0) {
        refuse(path, 'api.timeoutMs', 'must be a positive integer');
      }
      api.timeoutMs = apiRaw.timeoutMs as number;
    }
  }
  if (root.schedule === undefined) {
    refuse(path, 'schedule', 'required: a schedule-only bot (B1) must define schedule.tasks');
  }
  const schedule = checkObject(path, 'schedule', root.schedule);
  for (const key of Object.keys(schedule)) {
    if (key !== 'tasks') refuseUnknown(path, 'schedule', key, ['tasks']);
  }
  if (!Array.isArray(schedule.tasks) || schedule.tasks.length === 0) {
    refuse(path, 'schedule.tasks', 'must be a non-empty array of task objects');
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  const tasks = (schedule.tasks as Record<string, unknown>[]).map((t, i) => {
    const task = validateTask(path, checkObject(path, `schedule.tasks[${i}]`, t), i, seen);
    // §12: `onMiss: run` with singleFlight (the default) can stack up runs for one missed minute
    // after another; the design says the combination is allowed but must be loud at validate time.
    if (task.onMiss === 'run' && task.singleFlight) {
      warnings.push(
        `schedule.tasks[${i}].onMiss='run' with singleFlight=true (default): each missed fire still starts a new Run; set singleFlight=false only if stacking is intended`,
      );
    }
    if (task.onMiss === 'run' && task.maxCatchUp === undefined) {
      warnings.push(`schedule.tasks[${i}].onMiss='run' without maxCatchUp: unbounded catch-up; the default cap is 3 when the scheduler lands (B1)`);
    }
    return task;
  });
  return {
    alias,
    ...(description !== undefined ? { description } : {}),
    api,
    tasks,
    warnings,
  };
}
