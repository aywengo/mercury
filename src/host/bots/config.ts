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
import { suggestionFor } from '../../domain/suggestKey.ts';
import { findServerStampedField, serverStampedFieldMessage } from '../../api/serverStampedFields.ts';
import { validateCreateRequest } from '../../domain/createRequest.ts';
import { parseCron, parseTz } from './cron.ts';
import { readBotCredentials } from './credentials.ts';
import { resolveTemplate } from './scheduler.ts';
import { nextFires } from './status.ts';

/** The alias regex (§4.1): filesystem-safe, systemd-unit-safe, stable in log lines and owner ids. */
export const BOT_ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Task names appear in derived idempotency keys (colon-delimited) and log lines. */
const TASK_NAME_RE = /^[a-z0-9-]+$/;

const ON_MISS_VALUES = ['skip', 'collapse', 'run'] as const;

/** Top-level keys the v1 schema knows. `triggers`/`brain` are known but reserved (see below). */
const TOP_LEVEL_KEYS = [
  'description', 'api', 'schedule', 'triggers', 'brain',
] as const;

const API_KEYS = ['url', 'timeoutMs', 'via'] as const;

/** Where a bot dispatches: its own host (default) or through Fleet (FB2b, #973). */
const API_VIA_VALUES = ['host', 'fleet'] as const;
export type BotApiVia = (typeof API_VIA_VALUES)[number];

const TASK_KEYS = [
  'name', 'cron', 'tz', 'template', 'singleFlight', 'onMiss', 'maxCatchUp', 'select',
] as const;

/** `select` shape validation constants (docs/laya-integration-design.md §6.3, §10): 1-12
 *  candidates, mode shadow|enforce, minConfidence in (0,1) exclusive. Validated BEFORE the
 *  reserved refusal so a config written today is accepted by L1 unchanged (#826). */
const SELECT_MODES = ['shadow', 'enforce'] as const;
const MAX_SELECT_CANDIDATES = 12;

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
  api: { url?: string; timeoutMs?: number; via?: BotApiVia };
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
  if (!BOT_ALIAS_RE.test(alias)) {
    throw new Error(`bot alias must match ${BOT_ALIAS_RE.source}, got '${alias}'`);
  }
  return join(botsDir(env), `${alias}.json`);
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

/**
 * The `api.via: "fleet"` credential requirement (§6 of docs/fleet-bots-design.md, #973).
 *
 * The Fleet token lives in bot-credentials.json under the bot's alias, read through the SAME
 * validated reader the bot uses at startup, so a config cannot pass validate and then fail on
 * the first fire. Errors name the alias and the missing key, never a token value.
 */
function requireFleetToken(configPath: string, alias: string, env: NodeJS.ProcessEnv): void {
  let fleet: string | undefined;
  try {
    fleet = readBotCredentials(alias, env).fleet;
  } catch (err) {
    // A missing/unsafe/unparseable credentials file is already a named, value-free error; keep it
    // and name the field it is needed for, so the operator knows which way to fix it.
    refuse(configPath, 'api.via', `via 'fleet' needs a Fleet token for alias '${alias}': ${(err as Error).message}`);
  }
  if (fleet === undefined || fleet === '') {
    refuse(
      configPath,
      'api.via',
      `via 'fleet' requires a 'fleet' token for alias '${alias}' in bot-credentials.json (add "${alias}": { "api": ..., "fleet": ... })`,
    );
  }
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
  let api: { url?: string; timeoutMs?: number; via?: BotApiVia } = {};
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
    if (apiRaw.via !== undefined) {
      if (typeof apiRaw.via !== 'string' || !(API_VIA_VALUES as readonly string[]).includes(apiRaw.via)) {
        refuse(path, 'api.via', `must be one of ${API_VIA_VALUES.join(', ')}`);
      }
      api.via = apiRaw.via as BotApiVia;
    }
  }
  // `api.via: "fleet"` is unusable without Fleet's caller token, so it is refused HERE rather
  // than at the first fire (docs/fleet-bots-design.md §6, #973): a config that validates must be
  // one the bot can actually run. The check is skipped entirely for `via: "host"` and for a
  // config without `via`, so neither reads bot-credentials.json at load — today's behaviour.
  if (api.via === 'fleet') {
    requireFleetToken(path, alias, env);
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

/**
 * One bot's task-template validation result for `host bot validate` (A0-5, #989).
 */
export interface BotTemplateValidation {
  /** One line per validated task (printed as `template ok`). */
  ok: string[];
  /** One line per refused task (printed as `template FAIL`, exit 1). */
  findings: string[];
  /** One line per task whose deadline could not be checked (printed as `template warn`). */
  warnings: string[];
}

/**
 * Validate every task template the way the SCHEDULER will post it (A0-5, #989): the resolved
 * template -- `{{fire.*}}` filled from the task's NEXT scheduled fire (status.ts nextFires, the
 * same source `host bot status` renders; `notAfterAt` becomes `constraints.notAfter` on that
 * fire's date, and the dispatch-time `botTask` hint and constraint defaults applied) -- through
 * the SAME validateCreateRequest POST /api/runs uses, plus the #785 rule (a template must name
 * a repository) and the stamped-field refusal the route applies at fire time.
 *
 * A template that would 400 on every fire is a validate finding, not a failed night: night 1 of
 * #742 dispatched 20 Runs that all failed at workspace setup because a template had no
 * `repository` and nothing checked templates against the create model.
 */
export function validateBotTemplates(cfg: BotConfig, nowMs: number = Date.now()): BotTemplateValidation {
  const ok: string[] = [];
  const findings: string[] = [];
  const warnings: string[] = [];
  const next = new Map(nextFires(cfg, nowMs).map((nf) => [nf.task, nf]));
  for (const task of cfg.tasks) {
    const field = `schedule.tasks[${task.name}].template`;
    const fire = next.get(task.name);
    let body: Record<string, unknown>;
    if (fire === undefined || Number.isNaN(fire.fireMs)) {
      // The cron cannot fire within the 24h horizon: the placeholders and notAfterAt cannot be
      // resolved at a real fire. Validate everything else, strip the bot helper, and say the
      // deadline check did not run -- a schedule that never fires is a warning, not a refusal.
      body = { ...task.template };
      delete body.notAfterAt;
      warnings.push(`${field}: no fire within 24h; notAfterAt not checked`);
    } else {
      // The same wall-minute derivation the dispatch loop uses (scheduler.ts): date and time
      // are slices of the scheduled wall-minute id, in the task's zone.
      const tzParts = {
        date: fire.wallMinute.slice(1, 11),
        time: fire.wallMinute.slice(12, 17),
        iso: fire.wallMinute,
      };
      body = resolveTemplate(task, tzParts);
    }
    // The dispatch-time additions (scheduler.ts, section 4.3): the attribution hint and the
    // constraint defaults the bot applies to EVERY dispatch. Validating the body the scheduler
    // actually posts -- not the raw template -- is what makes the check measure a real fire.
    const constraints = { ...((body.constraints as Record<string, unknown> | undefined) ?? {}) };
    constraints.botTask = task.name;
    if (constraints.maxDurationMs === undefined) constraints.maxDurationMs = 3_600_000;
    if (constraints.maxRetries === undefined) constraints.maxRetries = 0;
    body.constraints = constraints;
    try {
      const stamped = findServerStampedField(body);
      if (stamped) throw new Error(serverStampedFieldMessage(stamped));
      validateCreateRequest(body, { requireRepository: true });
    } catch (err) {
      findings.push(`${field}: ${(err as Error).message}`);
      continue;
    }
    // The notAfter-in-the-future check above measures against NOW. A deadline that lies between
    // now and the fire's own instant passes that check, yet 400s at every fire (the #785 class,
    // one level down): a template whose deadline predates its first dispatch.
    if (fire !== undefined && !Number.isNaN(fire.fireMs)) {
      const na = constraints.notAfter;
      if (typeof na === 'string' && !Number.isNaN(Date.parse(na)) && Date.parse(na) <= fire.fireMs) {
        findings.push(`${field}: notAfter ${na} is in the past at the task's fire time (fires at ${new Date(fire.fireMs).toISOString()}); the Run would be unstartable`);
        continue;
      }
    }
    ok.push(task.name);
  }
  return { ok, findings, warnings };
}
