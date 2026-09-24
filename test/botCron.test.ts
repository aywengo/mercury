import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseCron, cronMatches, due, parseTz, CronParseError } from '../src/host/bots/cron.ts';
import { botOwnerId, dispatchKey, scheduledMinuteIso } from '../src/host/bots/keys.ts';

/**
 * Run a snippet in a child process with TZ pinned at startup: `local` wall-clock evaluation is
 * the one host-dependent path in the scheduler, and process.env.TZ mutated mid-run is only
 * reliably honoured on some platforms (it worked on macOS, silently did not on the CI runner).
 * Spawning pins it the way production would see it.
 */
async function runWithTz(tz: string, snippet: string): Promise<string> {
  const script = `import { due } from ${JSON.stringify(new URL('../src/host/bots/cron.ts', import.meta.url).href)};\n${snippet}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TZ: tz },
  });
  if (r.status !== 0) throw new Error(`DST child failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

const MIN = 60_000;
// A fixed clock: 2026-03-01 (a Sunday) 00:00:00 UTC.
const BASE = Date.UTC(2026, 2, 1, 0, 0, 0);

function utc(ms: number): { utc: string } {
  return { utc: new Date(ms).toISOString() };
}

test('parseCron accepts the documented syntax and expands steps and lists', () => {
  const p = parseCron('*/15 0-23/6 1,15 * 1-5');
  assert.deepEqual([...p.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...p.hours].sort((a, b) => a - b), [0, 6, 12, 18]);
  assert.ok(p.daysOfMonth!.has(1) && p.daysOfMonth!.has(15));
  assert.deepEqual([...p.months].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // 0-5 workdays; 7 folded into 0 is only for explicit 7s.
  for (const d of [1, 2, 3, 4, 5]) assert.ok(p.daysOfWeek!.has(d));
  assert.ok(!p.daysOfWeek!.has(0));
});

test('parseCron rejects malformed expressions, naming the field', () => {
  assert.throws(() => parseCron('* * * *'), CronParseError);
  assert.throws(() => parseCron('60 * * * *'), /minute/);
  assert.throws(() => parseCron('* 24 * * *'), /hour/);
  assert.throws(() => parseCron('* * 0 * *'), /day-of-month/);
  assert.throws(() => parseCron('* * * 13 *'), /month/);
  assert.throws(() => parseCron('* * * * 8'), /day-of-week/);
  assert.throws(() => parseCron('a * * * *'), /minute/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('1-5-9 * * * *'), CronParseError);
});

test('cronMatches on a fixed UTC clock (§15.1 set)', () => {
  // Every minute of 03:00 UTC.
  const everyMinute = parseCron('* * * * *');
  assert.ok(cronMatches(everyMinute, BASE + 181 * MIN, 'UTC'));
  // Nightly 03:15 UTC.
  const nightly = parseCron('15 3 * * *');
  assert.ok(cronMatches(nightly, Date.UTC(2026, 5, 10, 3, 15), 'UTC'));
  assert.ok(!cronMatches(nightly, Date.UTC(2026, 5, 10, 3, 14), 'UTC'));
  assert.ok(!cronMatches(nightly, Date.UTC(2026, 5, 10, 15, 15), 'UTC'));
  // Weekly Monday 09:00 UTC (2026-06-08 is a Monday).
  const weekly = parseCron('0 9 * * 1');
  assert.ok(cronMatches(weekly, Date.UTC(2026, 5, 8, 9, 0), 'UTC'));
  assert.ok(!cronMatches(weekly, Date.UTC(2026, 5, 7, 9, 0), 'UTC'));
  // Day-of-month OR day-of-week when both restricted: fires on the 1st AND on Mondays.
  const domOrDow = parseCron('0 0 1 * 1');
  assert.ok(cronMatches(domOrDow, Date.UTC(2026, 5, 1, 0, 0), 'UTC')); // Monday the 1st
  assert.ok(cronMatches(domOrDow, Date.UTC(2026, 5, 8, 0, 0), 'UTC')); // a Monday, not the 1st
  assert.ok(!cronMatches(domOrDow, Date.UTC(2026, 5, 9, 0, 0), 'UTC')); // a Tuesday
});

test('due() lists each scheduled minute in the window exactly once', () => {
  const fires = due('*/15 * * * *', BASE, BASE + 45 * MIN, 'UTC');
  assert.deepEqual(fires.map(scheduledMinuteIso), [
    '2026-03-01T00:15:00.000Z',
    '2026-03-01T00:30:00.000Z',
    '2026-03-01T00:45:00.000Z',
  ]);
  // An empty window (now == after) yields nothing.
  assert.deepEqual(due('*/15 * * * *', BASE, BASE, 'UTC'), []);
  // The window boundary is (after, now]: the minute AT afterMs is not re-fired.
  assert.deepEqual(due('* * * * *', BASE + 5 * MIN, BASE + 5 * MIN, 'UTC'), []);
  assert.deepEqual(due('* * * * *', BASE + 5 * MIN, BASE + 6 * MIN, 'UTC'), [BASE + 6 * MIN]);
});

test('fixed-offset tz evaluates the shifted wall clock', () => {
  // 23:15 UTC on 2026-05-10 is 01:15 (+02:00) on 2026-05-11.
  const inst = Date.UTC(2026, 4, 10, 23, 15);
  assert.ok(cronMatches(parseCron('15 1 * * *'), inst, { offsetMinutes: 120 }));
  assert.ok(!cronMatches(parseCron('15 23 * * *'), inst, { offsetMinutes: 120 }));
  assert.throws(() => parseTz('Europe/Warsaw'), /fixed offset/, 'named zones stay deferred (§16)');
  assert.equal(parseTz(undefined), 'UTC');
  assert.deepEqual(parseTz('+02:00'), { offsetMinutes: 120 });
  const tz = parseTz('-05:30') as { offsetMinutes: number };
  assert.equal(tz.offsetMinutes, -330);
});

test('tz: local — a 02:30 daily task fires exactly once on spring-forward (TZ=Europe/Warsaw)', async () => {
  // EU spring-forward 2026-03-29: 02:00 -> 03:00 local, so 02:30 local does not exist that day.
  // Host-local time must be pinned per PROCESS (TZ is read at startup; mutating process.env.TZ
  // mid-run is platform-dependent), so the DST cases run in a child process spawned with the TZ.
  const out = await runWithTz('Europe/Warsaw', `
    const fires = due('30 2 * * *', Date.UTC(2026, 2, 27, 0, 0), Date.UTC(2026, 2, 31, 0, 0), 'local');
    console.log(JSON.stringify(fires.map((ms) => new Date(ms).toISOString().slice(0, 10))));
  `);
  // 03-27 and 03-28 have a local 02:30; 03-29 (spring-forward) has none; 03-30 resumes.
  assert.deepEqual(JSON.parse(out.trim()), ['2026-03-27', '2026-03-28', '2026-03-30']);
});

test('tz: local — a 02:30 daily task fires exactly once on fall-back (TZ=Europe/Warsaw)', async () => {
  // EU fall-back 2026-10-25: 03:00 -> 02:00 local, so 02:30 local happens TWICE in wall-clock
  // terms; the scheduler must fire exactly once for the day.
  const out = await runWithTz('Europe/Warsaw', `
    const fires = due('30 2 * * *', Date.UTC(2026, 9, 24, 0, 0), Date.UTC(2026, 9, 27, 0, 0), 'local');
    const days = fires.map((ms) => new Date(ms).toISOString().slice(0, 10));
    console.log(JSON.stringify({ days, onFallBack: days.filter((d) => d === '2026-10-25').length }));
  `);
  const parsed = JSON.parse(out.trim()) as { days: string[]; onFallBack: number };
  assert.equal(parsed.onFallBack, 1, 'fall-back day fires once, not twice');
  assert.deepEqual(parsed.days, ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('derived keys are stable across restarts and pin the scheduled minute', () => {
  const k1 = dispatchKey('nightly-gc', 'workspace-audit', Date.UTC(2026, 5, 10, 3, 15, 30, 250));
  const k2 = dispatchKey('nightly-gc', 'workspace-audit', Date.UTC(2026, 5, 10, 3, 15, 59, 999));
  // Sub-minute jitter does not change the key: the key carries the scheduled MINUTE.
  assert.equal(k1, k2);
  assert.equal(k1, 'bot-nightly-gc:workspace-audit:2026-06-10T03:15:00.000Z');
  // A different task or minute or bot -> a different key.
  assert.notEqual(k1, dispatchKey('nightly-gc', 'other-task', Date.UTC(2026, 5, 10, 3, 15)));
  assert.notEqual(k1, dispatchKey('nightly-gc', 'workspace-audit', Date.UTC(2026, 5, 10, 3, 16)));
  assert.notEqual(k1, dispatchKey('other-bot', 'workspace-audit', Date.UTC(2026, 5, 10, 3, 15)));
});

test('botOwnerId enforces the B0-1 colon-free form and the alias grammar', () => {
  assert.equal(botOwnerId('nightly-gc'), 'bot-nightly-gc');
  assert.throws(() => botOwnerId('Bot'), /alias/);
  assert.throws(() => botOwnerId('bot_x'), /alias/);
  assert.throws(() => botOwnerId(''), /alias/);
});

test('scheduledMinuteIso truncates to the minute in UTC', () => {
  assert.equal(scheduledMinuteIso(Date.UTC(2026, 5, 10, 3, 15, 30)), '2026-06-10T03:15:00.000Z');
});
