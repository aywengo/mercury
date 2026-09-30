// The nightly bot config example (N1-5, issue #742): the shipped example must load through the
// REAL loader (it cannot rot) and its templates must resolve to the §4.3 window (notAfter 06:00
// local on the fire's date) across DST switches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBotConfig } from '../src/host/bots/config.ts';
import { parseCron, parseTz } from '../src/host/bots/cron.ts';
import { resolveTemplate } from '../src/host/bots/scheduler.ts';
import type { BotTaskConfig } from '../src/host/bots/config.ts';
import { makeEnv, tempDir } from './helpers.ts';

const EXAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'nightly-bot.json.example');

/** The example must be structurally valid even standalone: the loader is file-path based, so the
 * structural checks (parse + cron + tz + template) run here against the same primitives the real
 * loader uses; the file ships in deploy/ and is copied to the bots dir on install. */
function readExample(): { description?: string; schedule: { tasks: Record<string, unknown>[] } } {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

function taskOf(name: string): BotTaskConfig {
  const cfg = readExample();
  const raw = (cfg.schedule.tasks as Record<string, unknown>[]).find((t) => t.name === name);
  assert.ok(raw, `task ${name} exists in the example`);
  return {
    name,
    cron: raw.cron as string,
    tz: raw.tz as string | undefined,
    template: raw.template as Record<string, unknown>,
    singleFlight: raw.singleFlight as boolean,
    onMiss: raw.onMiss as 'skip',
  };
}

test('the example config parses and every task passes the real cron/tz parsers', () => {
  const cfg = readExample();
  assert.equal(cfg.schedule.tasks.length, 3);
  const names = cfg.schedule.tasks.map((t) => t.name);
  assert.deepEqual(names, ['nightly-e2e', 'nightly-next', 'nightly-report']);
  for (const t of cfg.schedule.tasks as Record<string, unknown>[]) {
    assert.equal(t.tz, 'local');
    assert.equal(t.singleFlight, true);
    assert.equal(t.onMiss, 'skip');
    parseCron(t.cron as string); // throws on a bad expression
    parseTz(t.tz as string);
    const template = t.template as Record<string, unknown>;
    // e2e and next carry the §4.3 window end 06:00; the report fires at 06:05 (after the
    // window it digests, #771) so its own deadline is 07:00 - a 06:00 deadline would be in the
    // past at fire time and the Run would never start.
    const expectedNotAfter = t.name === 'nightly-report' ? '07:00' : '06:00';
    assert.equal(template.notAfterAt, expectedNotAfter);
    const constraints = template.constraints as Record<string, number>;
    assert.ok(constraints.maxDurationMs > 0, 'every task sets maxDurationMs explicitly');
    assert.equal(constraints.maxRetries, 0, 'nightly runs never retry into the window');
    // nightly SKILL.md 1.1.1: skills are listed explicitly per task, so the procedure never
    // depends on keyword matching against issue text - and only nightly-next, the task that
    // fixes, gets any skill. e2e files or comments only (the testing skill says to fix regressions, so it
    // is not loaded there - Copilot review on #781); the report only reports
    // (explicit [] = no skills, Crew #724 decision 1A).
    const expectedSkills: Record<string, string[]> = {
      'nightly-e2e': [],
      'nightly-next': ['issue-fix-loop', 'planning', 'implementation', 'testing'],
      'nightly-report': [],
    };
    assert.deepEqual(template.skills, expectedSkills[t.name as string]);
  }
});

test('the example loads through the REAL loadBotConfig with zero warnings (cannot rot)', () => {
  // Acceptance #1: the shipped example is copied into a temp bots dir and validated by the real
  // loader - unknown keys, bad crons, missing template.task etc. all refuse here, so the example
  // cannot silently rot when the schema changes.
  const root = tempDir('mercury-nightly-bot-');
  try {
    const botsDir = join(root, 'mercury', 'bots');
    mkdirSync(botsDir, { recursive: true });
    copyFileSync(EXAMPLE_PATH, join(botsDir, 'nightly.json'));
    const cfg = loadBotConfig('nightly', { XDG_CONFIG_HOME: root });
    assert.equal(cfg.alias, 'nightly');
    assert.deepEqual(cfg.tasks.map((t2) => t2.name), ['nightly-e2e', 'nightly-next', 'nightly-report']);
    assert.deepEqual(cfg.warnings, [], 'zero validation warnings');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the e2e task duration is sized past the default 1h (the suite can exceed it)', () => {
  const e2e = taskOf('nightly-e2e');
  const constraints = e2e.template.constraints as { maxDurationMs: number };
  assert.ok(constraints.maxDurationMs > 3_600_000, 'explicit, above the 1h default');
});

test('next fires at most every 20 minutes and the last fire is 04:40 (inside the window)', () => {
  const next = taskOf('nightly-next');
  assert.equal(next.cron, '*/20 0-4 * * *');
  const constraints = next.template.constraints as { maxDurationMs: number };
  // #800: 4h room for feature-sized fix-loops (80 min timed out five times), same cap as the
  // e2e task. notAfterAt 06:00 still ends every Run at the window boundary, so even the 04:40
  // fire cannot leak past 06:00; the cap only stops a single Run from eating the whole night.
  assert.ok(constraints.maxDurationMs <= 4 * 3_600_000);
  assert.ok(constraints.maxDurationMs > 80 * 60_000, 'feature work needs more than the old 80 min');
});

test('the report fires 06:05 (§4.3 window just ended) and its deadline is 07:00, never a past 06:00', () => {
  // #771: the report must list runs stopped AT 06:00 - impossible from a 05:40 fire - so it
  // fires just after the window ends. Its notAfterAt resolves on ITS fire date to 07:00: a
  // 06:00 deadline would already be in the past at 06:05 and the Run would never start.
  const report = taskOf('nightly-report');
  assert.equal(report.cron, '5 6 * * *');
  // The task text must not tell the agent to stay inside the 06:00 window: it runs after it.
  assert.doesNotMatch(report.template.task as string, /inside the 06:00 window/);
  assert.match(report.template.task as string, /night that just ended/);
  report.tz = 'local';
  const resolved = resolveTemplate(report, { date: '2026-09-27', time: '06:05', iso: 'w2026-09-27T06:05' });
  const notAfter = new Date((resolved.constraints as { notAfter: string }).notAfter);
  assert.equal(notAfter.getTime(), new Date(2026, 8, 27, 7, 0).getTime(), '07:00 local on the fire date');
});

test('notAfterAt resolves to 06:00 wall on the FIRE local date (same date, never shifted)', () => {
  // Shipped config uses tz: 'local' - the scheduler constructs the deadline with the host's
  // zone rules (new Date(y, mo-1, d, hh, mm)), so on a Poznań host the EU DST switch nights
  // are handled by the zone itself. The assertion pins the contract in ANY host zone: the
  // deadline is 06:00 wall clock on the fire's wall date (an implementation that derived the
  // date from the fire INSTANT's UTC calendar day would be off by one day for a 00:05 fire
  // west of UTC, and this assertion fails in every zone).
  const e2e = taskOf('nightly-e2e');
  for (const fireDate of ['2026-09-27', '2026-03-29', '2026-10-25']) {
    const [y, mo, d] = fireDate.split('-').map(Number);
    const resolved = resolveTemplate(e2e, {
      date: fireDate,
      time: '00:05',
      iso: `w${fireDate}T00:05`,
    });
    const notAfter = (resolved.constraints as { notAfter: string }).notAfter;
    assert.equal(Date.parse(notAfter), new Date(y!, mo! - 1, d!, 6, 0).getTime(), fireDate);
    // The fire date lands in the task text, and the helper key is consumed.
    assert.ok(String(resolved.task).includes(fireDate));
    assert.ok(!('notAfterAt' in resolved));
  }
});

test('fixed-offset zone: the deadline uses the TASK-zone date, not the UTC date of the fire instant', () => {
  // A 00:05 (+01:00) fire on 2026-03-29 is 2026-03-28T23:05Z; a naive UTC-date implementation
  // would resolve notAfter to 03-28T05:00Z - one day early. The resolver must use the wall date.
  const e2e = taskOf('nightly-e2e');
  e2e.tz = '+01:00';
  const spring = resolveTemplate(e2e, { date: '2026-03-29', time: '00:05', iso: 'w2026-03-29T00:05' });
  assert.equal((spring.constraints as { notAfter: string }).notAfter, '2026-03-29T05:00:00.000Z');
  e2e.tz = '+02:00';
  // DST-switch night 2026-10-25: 00:05 CEST = 2026-10-24T22:05Z; 06:00 wall (+02:00) = 04:00Z.
  const autumn = resolveTemplate(e2e, { date: '2026-10-25', time: '00:05', iso: 'w2026-10-25T00:05' });
  assert.equal((autumn.constraints as { notAfter: string }).notAfter, '2026-10-25T04:00:00.000Z');
});

test('the example documents the fixed-offset DST caveat and ships tz local for the host', () => {
  // parseTz accepts only UTC | local | fixed offsets (no IANA names), so Warsaw time is spelled
  // tz: 'local' on a host set to Europe/Warsaw. The description must say so, or an operator on a
  // UTC host copies a config whose midnight is not Poznan midnight.
  const cfg = readExample();
  const description = String(cfg.description ?? '');
  assert.ok(description.includes('tz'), 'description mentions how tz local maps to the host zone');
});


test('every example task template carries a repository (#785)', () => {
  // Night 1 of #742 dispatched 20 Runs that ALL failed at workspace setup: the templates had no
  // repository, and the worker cannot build a workspace without one. resolveTemplate forwards the
  // template verbatim to POST /api/runs, so the example must carry a repository object per task.
  const cfg = readExample();
  for (const raw of cfg.schedule.tasks) {
    const repo = (raw as { template?: { repository?: unknown } }).template?.repository;
    assert.ok(repo && typeof repo === 'object' && !Array.isArray(repo), `${String((raw as { name: string }).name)}: template.repository is an object`);
    const url = (repo as { url?: unknown }).url;
    assert.equal(typeof url, 'string');
    assert.match(url as string, /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+\.git$/, 'an https clone URL');
  }
});

test('a resolved example template passes RunService.create and persists the repository (#785)', () => {
  // The failure was at WORKSPACE SETUP in the worker, which only sees what create PERSISTED.
  // Drive the real create path (worker disabled - create must not touch the workspace) with the
  // exact body the bot dispatches: task/constraints/skills/repository from the resolved template.
  const env = makeEnv({ workerEnabled: false });
  try {
    const cfg = readExample();
    const task = cfg.schedule.tasks.find((t) => t.name === 'nightly-next') as unknown as BotTaskConfig;
    // Derive the fire minute from NOW (+1 day) instead of a hard-coded date (#787 review r2):
    // notAfterAt resolves to 06:00 local on the FIRE date, and validateConstraints rejects a
    // notAfter in the past - a fixed date is a time bomb that starts failing the day after it.
    // The fire wall-minute is only a substitution input; any in-window date keeps the test honest.
    const fire = new Date(Date.now() + 24 * 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const date = `${fire.getFullYear()}-${pad(fire.getMonth() + 1)}-${pad(fire.getDate())}`;
    const body = resolveTemplate(task, { date, time: '00:00', iso: `w${date}T00:00` }) as {
      task: string; constraints: Record<string, unknown>; skills: string[]; repository: { url: string };
    };
    const run = env.runService.create({
      ownerId: 'bot-nightly',
      task: body.task,
      constraints: body.constraints as never,
      skills: body.skills,
      repository: body.repository,
      idempotencyKey: 'test-785-nightly-next',
    });
    // Read the row BACK through the store: the worker sees the persisted Run, not create's
    // in-memory return, so the seam this test pins is store round-trip, not the return value.
    const stored = env.runs.get(run.id);
    assert.ok(stored, 'the created Run row exists');
    assert.equal((stored!.repository as { url?: string } | undefined)?.url, 'https://github.com/aywengo/mercury.git', 'the STORED Run carries repository.url - what the worker actually reads');
    // The inverse defect: create WITHOUT a repository still succeeds - that is precisely what made
    // night 1 fail 20 Runs downstream (worker-side). Keep this documented, not 'fixed' here: create
    // intentionally accepts repo-less Runs (localPath runs, later repo attach).
    const repoless = env.runService.create({
      ownerId: 'bot-nightly',
      task: 'no repository - the worker will fail this at workspace setup (#785)',
      idempotencyKey: 'test-785-repoless',
    });
    assert.ok(!(repoless.repository as { url?: string } | undefined)?.url, 'create accepts a repo-less Run - the worker fails it later, which is the #785 trap documented, not hidden');
  } finally {
    env.close();
  }
});
