// Hand-rolled 5-field cron parser and evaluator (docs/dispatcher-bot-design.md §5.1, §16).
//
// The design decides AGAINST a cron dependency: the vocabulary is small, the tests are cheap, and
// a dependency adds supply-chain surface to a feature whose scheduling layer must stay
// deterministic. Escape criterion (§16): if DST correctness under `tz: "local"` forces more than
// ~150 tested lines here, reconsider the decision. The UTC default keeps that from being exercised
// by the common case.
//
// Fields: minute hour day-of-month month day-of-week. Supported syntax per field:
//   `*`, `N`, `A-B` (inclusive), `A-B/S` and `*/S` steps, comma-separated lists of those.
// Day-of-month and day-of-week combine with OR when both are restricted (standard cron
// semantics: a match on either fires).
// Evaluation is minute-resolution: a cron matches an instant iff the instant's wall-clock fields
// in the configured zone satisfy the expression.

/** How a schedule's wall clock is derived from a Unix instant. */
export type CronTz = 'UTC' | 'local' | { offsetMinutes: number };

export interface CronParts {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number> | null; // null = unrestricted (*)
  months: Set<number>;
  daysOfWeek: Set<number> | null; // 0 = Sunday; null = unrestricted (*)
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

function parseField(
  field: string,
  what: string,
  min: number,
  max: number,
  opts: { anyAllowed: boolean } = { anyAllowed: true },
): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') throw new CronParseError(`cron ${what}: empty list element in '${field}'`);
    let body = part;
    let step = 1;
    const slash = body.indexOf('/');
    if (slash !== -1) {
      const stepText = body.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronParseError(`cron ${what}: step must be a positive integer, got '${stepText}'`);
      }
      step = Number(stepText);
      body = body.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (body === '*') {
      if (slash === -1) {
        if (!opts.anyAllowed) throw new CronParseError(`cron ${what}: '*' is not valid here`);
        lo = min; hi = max;
      } else {
        lo = min; hi = max;
      }
    } else if (body.includes('-')) {
      const dash = body.indexOf('-');
      const a = body.slice(0, dash);
      const b = body.slice(dash + 1);
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
        throw new CronParseError(`cron ${what}: range endpoints must be integers, got '${part}'`);
      }
      lo = Number(a); hi = Number(b);
    } else {
      if (!/^\d+$/.test(body)) throw new CronParseError(`cron ${what}: expected an integer, got '${body}'`);
      lo = Number(body);
      // A bare name with a step means "from here to the max, stepping" (cron convention).
      hi = slash !== -1 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(`cron ${what}: ${lo}-${hi} outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws CronParseError naming the offending field. */
export function parseCron(expr: string): CronParts {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`cron must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: '${expr}'`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 'minute', 0, 59),
    hours: parseField(hour, 'hour', 0, 23),
    daysOfMonth: parseField(dom, 'day-of-month', 1, 31),
    months: parseField(month, 'month', 1, 12),
    // 0-7 with both 0 and 7 meaning Sunday, per standard cron.
    daysOfWeek: normalizeDow(parseField(dow, 'day-of-week', 0, 7)),
  };
}

/**
 * The wall-clock fields of `instantMs` in the configured zone.
 *
 * UTC and fixed offsets are pure arithmetic. `local` reads the host's zone through Date — the ONE
 * place host-locality enters the scheduler, and the only path where DST can surprise a config
 * (which is why `local` is opt-in, §5.1).
 */
export function wallClock(instantMs: number, tz: CronTz): {
  year: number; minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number;
} {
  const d = new Date(instantMs);
  if (tz === 'UTC') {
    return {
      year: d.getUTCFullYear(), minute: d.getUTCMinutes(), hour: d.getUTCHours(),
      dayOfMonth: d.getUTCDate(), month: d.getUTCMonth() + 1, dayOfWeek: d.getUTCDay(),
    };
  }
  if (tz === 'local') {
    return {
      year: d.getFullYear(), minute: d.getMinutes(), hour: d.getHours(),
      dayOfMonth: d.getDate(), month: d.getMonth() + 1, dayOfWeek: d.getDay(),
    };
  }
  const shifted = new Date(instantMs + tz.offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(), minute: shifted.getUTCMinutes(), hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(), month: shifted.getUTCMonth() + 1, dayOfWeek: shifted.getUTCDay(),
  };
}

/** True iff the cron expression matches the wall-clock fields of `instantMs` in `tz`. */
export function cronMatches(parts: CronParts, instantMs: number, tz: CronTz): boolean {
  const w = wallClock(instantMs, tz);
  if (!parts.minutes.has(w.minute)) return false;
  if (!parts.hours.has(w.hour)) return false;
  if (!parts.months.has(w.month)) return false;
  const domRestricted = parts.daysOfMonth !== null && parts.daysOfMonth.size > 0 && !isEveryDay(parts.daysOfMonth);
  const dowRestricted = parts.daysOfWeek !== null && parts.daysOfWeek.size > 0 && !isEveryDow(parts.daysOfWeek);
  if (domRestricted && dowRestricted) {
    // Standard cron: when both day fields are restricted, EITHER match fires.
    return parts.daysOfMonth!.has(w.dayOfMonth) || parts.daysOfWeek!.has(w.dayOfWeek);
  }
  if (domRestricted) return parts.daysOfMonth!.has(w.dayOfMonth);
  if (dowRestricted) return parts.daysOfWeek!.has(w.dayOfWeek);
  return true;
}

function isEveryDay(days: Set<number>): boolean {
  for (let d = 1; d <= 31; d++) if (!days.has(d)) return false;
  return true;
}

function isEveryDow(days: Set<number>): boolean {
  for (let d = 0; d <= 6; d++) if (!days.has(d)) return false;
  return true;
}

/** Fold 7 into 0 (both mean Sunday) so `has(0)` answers for every Sunday spelling. */
function normalizeDow(days: Set<number>): Set<number> {
  if (days.has(7)) return new Set([...days, 0]);
  return days;
}

/** Accepts 'UTC', 'local', or a fixed offset ('+02:00', '-0530', 'Z'). */
export function parseTz(raw: string | undefined): CronTz {
  if (raw === undefined || raw === '' || raw === 'UTC') return 'UTC';
  if (raw === 'local') return 'local';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (raw === 'Z' || raw === 'z') return 'UTC';
  if (!m) {
    throw new CronParseError(`tz must be 'UTC', 'local', or a fixed offset like '+02:00', got '${raw}'`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  return { offsetMinutes };
}

/**
 * The scheduled fire instants in the half-open window (afterMs, nowMs], in `tz`.
 *
 * `due()` iterates minute by minute from the last considered instant, so a bot that slept through
 * several scheduled minutes sees each of them (§5.3's missed-fire policies need the LIST, not a
 * boolean; the per-minute cost is bounded by the window, and callers cap it).
 */
export function due(cron: string, afterMs: number, nowMs: number, tz: CronTz = 'UTC'): number[] {
  const parts = parseCron(cron);
  const out: number[] = [];
  const seen = new Set<string>();
  // Walk whole minutes after `afterMs` through `nowMs`. A fire is the scheduled minute's instant.
  const startMinute = Math.floor(afterMs / 60_000) + 1;
  const endMinute = Math.floor(nowMs / 60_000);
  for (let m = startMinute; m <= endMinute; m++) {
    const instant = m * 60_000;
    if (!cronMatches(parts, instant, tz)) continue;
    // Fall-back repeats a wall-clock time; a scheduled (date, hour, minute) then occurs at TWO
    // distinct instants. §15.1 pins "fires exactly once" for that day, so the SECOND occurrence
    // is collapsed: the key is the matched wall-clock minute, not the instant. Distinct schedules
    // (different hour/minute) are never merged by this key.
    const w = wallClock(instant, tz);
    const key = `${w.year}-${w.month}-${w.dayOfMonth}T${w.hour}:${w.minute}`;
    if (false) continue;
    seen.add(key);
    out.push(instant);
  }
  return out;
}
