import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parse } from 'yaml';
import { tempDir } from './helpers.ts';

// nightly-watchdog (the 2026-10-19->20 host outage): a morning without a nightly report opens one
// alarm issue; a later report closes it. The step's bash is executed for real against a fake `gh`
// on PATH, so these tests exercise the shipped script, not a description of it.

const ROOT = join(import.meta.dirname, '..');
const WF = parse(readFileSync(join(ROOT, '.github/workflows/nightly-watchdog.yml'), 'utf8')) as {
  on: { schedule: { cron: string }[] };
  permissions: Record<string, string>;
  jobs: { check: { steps: { run: string }[] } };
};
const SCRIPT = WF.jobs.check.steps[0]!.run;
const HAVE_JQ = spawnSync('jq', ['--version']).status === 0;

function runWatchdog(opts: { night: string; reports: { number: number; title: string }[]; alarms: { number: number; title: string }[] }) {
  const dir = tempDir('watchdog-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'reports.json'), JSON.stringify(opts.reports));
  writeFileSync(join(dir, 'alarms.json'), JSON.stringify(opts.alarms));
  // Fake gh: answers the two list calls from fixtures and records every write.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"issue list"*"nightly:report"*) cat "${dir}/reports.json" ;;
  *"issue list"*"--label nightly"*) cat "${dir}/alarms.json" ;;
  *"issue create"*|*"issue close"*) printf '%s\\n' "$*" >> "${log}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const script = join(dir, 'step.sh');
  writeFileSync(script, SCRIPT);
  const r = spawnSync('bash', [script], {
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x', GH_REPO: 'o/r', NIGHT_INPUT: opts.night },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('nightly-watchdog: scheduled after the report deadline, issues:write only', () => {
  assert.deepEqual(WF.on.schedule.map((s) => s.cron), ['30 6 * * *'], '06:30 UTC = 08:30 CEST / 07:30 CET, after the 07:00 report deadline');
  assert.deepEqual(WF.permissions, { issues: 'write' });
});

test('nightly-watchdog: looks for the exact title nightly-report writes', () => {
  const report = readFileSync(join(ROOT, '.agents/skills/nightly/report.ts'), 'utf8');
  assert.ok(report.includes('const title = `nightly report — ${opts.night}`;'), 'report.ts title format');
  assert.ok(SCRIPT.includes('report_title="nightly report — $night"'), 'the watchdog matches it byte for byte (em dash)');
});

test('nightly-watchdog: a missing report opens exactly one alarm; a rerun does not duplicate it', { skip: !HAVE_JQ && 'jq not installed' }, () => {
  const night = '2026-10-20';
  const first = runWatchdog({ night, reports: [{ number: 1003, title: 'nightly report — 2026-10-19' }], alarms: [] });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.calls.length, 1);
  assert.match(first.calls[0]!, /issue create --title nightly: no report for 2026-10-20 --label nightly --label bug --label priority: high/);

  const again = runWatchdog({ night, reports: [], alarms: [{ number: 2000, title: 'nightly: no report for 2026-10-20' }] });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.calls, [], 'an open alarm for the same night is not duplicated');
});

test('nightly-watchdog: a report closes the alarm for its night and earlier ones, never later ones', { skip: !HAVE_JQ && 'jq not installed' }, () => {
  const r = runWatchdog({
    night: '2026-10-21',
    reports: [{ number: 1019, title: 'nightly report — 2026-10-21' }],
    alarms: [
      { number: 2000, title: 'nightly: no report for 2026-10-20' },
      { number: 2001, title: 'nightly: no report for 2026-10-21' },
      { number: 2002, title: 'nightly: no report for 2026-10-22' },
      { number: 2003, title: 'something else' },
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.some((c) => c.startsWith('issue close 2000')));
  assert.ok(r.calls.some((c) => c.startsWith('issue close 2001')));
  assert.ok(r.calls.every((c) => !c.includes('2002') && !c.includes('2003')));
  assert.ok(r.calls.every((c) => c.includes('#1019')), 'the close comment names the report');
});

test('nightly-watchdog: a malformed date input fails without writing anything', { skip: !HAVE_JQ && 'jq not installed' }, () => {
  const r = runWatchdog({ night: '20-10-2026; rm -rf /', reports: [], alarms: [] });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
});
