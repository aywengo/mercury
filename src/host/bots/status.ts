// `host bot status` (docs/dispatcher-bot-design.md §11; B1-2, issue #736).
//
// Three views per bot: NEXT FIRES (pure config + cron — works offline), LAST ACTIONS and the
// DISPATCHES-PER-HOUR count (API-backed, owner-scoped list; §6.2: counted from the API, never
// from mutable local state). If the API is unreachable the command prints everything obtainable,
// marks the API-backed sections unavailable with the reason, and exits non-zero — a read-only
// command still fails loudly when it cannot do its whole job.

import { due, parseTz, type CronTz } from './cron.ts';
import { scheduledWallMinuteId } from './keys.ts';
import type { BotConfig } from './config.ts';
import type { SchedulerClient, BotRunView } from './scheduler.ts';

export interface NextFire {
  task: string;
  fireMs: number;
  wallMinute: string;
  tz: string;
}

/** The next scheduled fire per task, strictly after `nowMs`, within `horizonMs` (default 24h). */
export function nextFires(cfg: BotConfig, nowMs: number, horizonMs = 24 * 3_600_000): NextFire[] {
  const out: NextFire[] = [];
  const horizonH = Math.round(horizonMs / 3_600_000);
  for (const task of cfg.tasks) {
    const tz: CronTz = parseTz(task.tz);
    const fires = due(task.cron, nowMs, nowMs + horizonMs, tz);
    if (fires.length === 0) {
      // A task whose cron cannot fire within the horizon is reported as such, not silently
      // dropped: an operator staring at `status` must see the difference between "fires later"
      // and "this schedule is impossible on this clock". The message names the actual horizon.
      out.push({ task: task.name, fireMs: NaN, wallMinute: `none within ${horizonH}h`, tz: task.tz ?? 'UTC' });
      continue;
    }
    out.push({ task: task.name, fireMs: fires[0]!, wallMinute: scheduledWallMinuteId(fires[0]!, tz), tz: task.tz ?? 'UTC' });
  }
  return out;
}

export interface StatusView {
  nextFires: NextFire[];
  lastActions: { id: string; task: string | null; status: string; createdAt: string }[];
  dispatchesLastHour: number;
  hourlyCapHit: boolean;
  apiError?: string;
}

/**
 * Build the status view. Walks the owner-run list (paged) until Runs fall out of the last-hour
 * window for the count, and keeps the first page's entries for last-actions.
 */
export async function statusView(cfg: BotConfig, client: SchedulerClient, nowMs: number): Promise<StatusView> {
  const view: StatusView = { nextFires: nextFires(cfg, nowMs), lastActions: [], dispatchesLastHour: 0, hourlyCapHit: false };
  const hourAgoMs = nowMs - 3_600_000;
  let cursor: string | null = null;
  let firstPage = true;
  let pastWindow = false;
  let capHit = false;
  try {
    for (let page = 0; page < 20 && !pastWindow; page++) {
      const res = await client.listOwnRuns(200, cursor);
      for (const run of res.runs) {
        if (firstPage) {
          view.lastActions.push({ id: run.id, task: run.constraints?.botTask ?? null, status: run.status, createdAt: run.createdAt ?? '' });
        }
        // Only a FINITE timestamp decides the window cut-off: a missing/unparseable createdAt
        // neither counts nor ends the walk (treating it as "past window" would undercount).
        const createdAtMs = Date.parse(run.createdAt ?? '');
        if (!Number.isFinite(createdAtMs)) continue;
        if (createdAtMs >= hourAgoMs) {
          view.dispatchesLastHour++;
        } else {
          // Runs arrive newest-first; the first out-of-window Run means every later Run is older
          // too. Stop paging — including on the first page (its remaining last-actions are still
          // collected by finishing this loop; no further page is fetched).
          pastWindow = true;
          if (!firstPage) break;
        }
      }
      firstPage = false;
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
      if (page === 19) capHit = true;
    }
  } catch (err) {
    view.apiError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  view.hourlyCapHit = capHit;
  return view;
}

export function renderStatus(cfg: BotConfig, view: StatusView, nowMs: number): string {
  const lines: string[] = [];
  lines.push(`bot ${cfg.alias} (${cfg.tasks.length} task${cfg.tasks.length === 1 ? '' : 's'})`);
  for (const nf of view.nextFires) {
    if (Number.isNaN(nf.fireMs)) {
      lines.push(`  next ${nf.task}: ${nf.wallMinute} (${nf.tz})`);
    } else {
      const inMin = Math.round((nf.fireMs - nowMs) / 60_000);
      lines.push(`  next ${nf.task}: ${new Date(nf.fireMs).toISOString()} [${nf.wallMinute}] (${nf.tz}, in ${inMin} min)`);
    }
  }
  if (view.apiError) {
    lines.push(`  last actions: UNAVAILABLE (${view.apiError})`);
    lines.push(`  dispatches in the last hour: UNAVAILABLE (${view.apiError})`);
  } else {
    for (const a of view.lastActions.slice(0, 10)) {
      lines.push(`  action ${a.id} task=${a.task ?? '-'} ${a.status} ${a.createdAt}`);
    }
    if (view.lastActions.length === 0) lines.push('  action (none yet)');
    lines.push(`  dispatches in the last hour: ${view.dispatchesLastHour}${view.hourlyCapHit ? ' (partial: page cap reached)' : ''}`);
  }
  return lines.join('\n');
}
