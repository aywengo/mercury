import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// deploy/README.md path consistency (issue #70).
// The bug here was documentation drift, not code: the app defaults to a RELATIVE ./mercury.db
// (resolved against WorkingDirectory=/opt/mercury) while the backup cron read
// /var/lib/mercury/mercury.db. A deploy that followed the guide backed up a file the application
// never writes to, and nothing reported the disagreement. So the guard is a test that the paths in
// the guide agree with each other.
import { readFileSync } from 'node:fs';

const DEPLOY = join(import.meta.dirname, '..', 'deploy');
const README = readFileSync(join(import.meta.dirname, '..', 'deploy', 'README.md'), 'utf8');
const UNITS = ['mercury.service', 'mercury-worker.service']
  .map((f) => readFileSync(join(import.meta.dirname, '..', 'deploy', f), 'utf8'));

test('the ops guide names one database path everywhere it appears (issue #70)', () => {
  const env = README.match(/MERCURY_DB=(\S+)/)?.[1];
  assert.ok(env, 'the guide must state MERCURY_DB explicitly; the app default is relative');
  assert.ok(env.startsWith('/'), `MERCURY_DB must be absolute, got ${env}`);

  // Match the backup CRON LINE, not the specific schedule: changing 02:30 to 03:00 is a harmless
  // ops preference and must not fail a test about path agreement.
  const cron = README.match(/^\S+ \S+ \S+ \S+ \S+ .*backup\.sh.*$/m)?.[0] ?? '';
  assert.ok(cron, 'the backup cron line must be present');
  const cronDb = cron.match(/MERCURY_DB=(\S+)/)?.[1];
  assert.equal(cronDb, env, 'backup cron must read the same database the app writes');

  // Restore names two kinds of path: the backup ARCHIVE it reads (under BACKUP_DIR) and the LIVE
  // database it writes. Only the live one must equal MERCURY_DB -- checking every path would fail
  // on the archive, which is a different file by design.
  const restore = README.slice(README.indexOf('## Restore'));
  // Tolerate cp flags (`cp -v`, `cp -p`): the invariant is the DESTINATION, not the flag list.
  const cp = restore.match(/cp\s+(?:-\S+\s+)*\S+\s+(\S+\.db)/);
  assert.ok(cp, 'the restore must show an explicit cp into the live database path');
  assert.equal(cp[1], env, 'restore must write the database the app actually reads');
  // (The stale -wal cleanup in this section is covered by test/backup.test.ts under issue #69;
  // asserting it here would make this test depend on that branch landing first.)
});

test('the guide documents both relative-default settings and the workspace base (issue #70)', () => {
  // MERCURY_WORKSPACE_BASE has the same relative-default trap as MERCURY_DB.
  assert.match(README, /MERCURY_WORKSPACE_BASE=\/\S+/,
    'MERCURY_WORKSPACE_BASE must be set absolutely, not left at ./workspaces');
  assert.match(README, /WorkingDirectory=\/opt\/mercury/,
    'the guide must say WHERE relative defaults resolve to');
  assert.match(README, /\.\/mercury\.db/,
    'the guide must warn that the application default is a relative path');
});

test('the environment file is mandatory and its contents are spelled out (issue #70)', () => {
  for (const unit of UNITS) {
    // A leading '-' makes EnvironmentFile optional; without it systemd fails closed. The guide
    // must not imply the file is advisory.
    const line = unit.match(/^EnvironmentFile=(.*)$/m)?.[1] ?? '';
    assert.ok(line, 'each unit must declare EnvironmentFile');
    assert.ok(!line.startsWith('-'), 'EnvironmentFile must stay mandatory (no leading -)');
    assert.equal(line, '/etc/mercury/mercury.env');
  }
  assert.match(README, /chmod 600 \/etc\/mercury\/mercury\.env/,
    'the env file holds API tokens and the guide must say to protect it');
});

test('the application defaults really are relative, so the warning stays accurate (issue #70)', () => {
  // If someone aligns the code defaults to absolute production paths, this test fails and the
  // guide's warning should be simplified rather than left to mislead.
  const cfg = readFileSync(join(import.meta.dirname, '..', 'src', 'config.ts'), 'utf8');
  assert.match(cfg, /MERCURY_DB \?\? '\.\/mercury\.db'/,
    'config default changed -- re-check whether the ops guide still needs the warning');
  assert.match(cfg, /MERCURY_WORKSPACE_BASE \?\? '\.\/workspaces'/);
});

test('the guide creates the config file before enabling the services (issue #70 review)', () => {
  // The units fail closed without EnvironmentFile, so a guide that runs `enable --now` first makes
  // a reader hit a startup failure and then hunt for the cause. Ordering IS the invariant here, so
  // it needs an assertion or the fix silently regresses on the next doc reshuffle.
  // Match the COMMAND, not prose mentions of it: the config section refers to
  // `systemctl enable --now` in a sentence, and indexOf would find that first and report the
  // ordering as inverted when the actual command comes later.
  const enableIdx = README.indexOf('sudo systemctl enable --now');
  const configIdx = README.indexOf('MERCURY_DB=');
  assert.ok(enableIdx >= 0, 'the guide must show how to enable the services');
  assert.ok(configIdx >= 0, 'the guide must state MERCURY_DB');
  assert.ok(configIdx < enableIdx,
    'the env file contents must appear BEFORE `systemctl enable --now`; the units fail closed without it');
  // And the guide must say so, not merely happen to be ordered correctly.
  assert.match(README, /before[\s\S]{0,120}systemctl enable --now|BEFORE enabling/i,
    'the guide must state that the config file is required before enabling');
});

// Issue #73 L4 and L10: shipped deploy configuration that cannot do what it claims.

test('no logrotate config is shipped, because nothing writes log files (issue #73 L4)', () => {
  // The app logs JSON to stdout/stderr and systemd captures it in the journal, so the logrotate
  // config that used to ship here rotated /var/log/mercury/*.log -- a directory nothing ever wrote
  // to. It looked like log management and was inert. Removed rather than documented: a config file
  // that provably cannot act is a liability, not a convenience.
  assert.equal(existsSync(join(DEPLOY, 'logrotate.conf')), false,
    'logrotate config must not ship; rotation belongs to journald');
  // And the guide must not tell anyone to install it.
  assert.doesNotMatch(README, /cp\s+logrotate\.conf/, 'the install steps must not reference logrotate');
  // The replacement has to be stated, not merely implied by an absence.
  assert.match(README, /journalctl -u mercury-worker/, 'the guide must say where the logs actually go');
  assert.match(README, /journald\.conf|SystemMaxUse/, 'the guide must name what does the rotating');
});

test('the sandbox/docker conflict has an opt-in drop-in, and the baseline stays hardened (issue #73 L10)', () => {
  const dropin = join(DEPLOY, 'mercury-worker-sandbox.conf');
  assert.ok(existsSync(dropin), 'an opt-in drop-in for the docker socket must ship');
  const body = readFileSync(dropin, 'utf8');
  const rw = body.match(/^ReadWritePaths=(.+)$/m)?.[1] ?? '';
  assert.ok(rw.includes('/var/run/docker.sock'), 'it must re-permit the socket path');
  // systemd APPENDS list-type settings from drop-ins, so restating the unit's own paths is
  // redundant -- and it reads as though this opt-in file owned them, which invites someone to
  // delete the line from the main unit later.
  assert.ok(!rw.includes('/opt/mercury') && !rw.includes('/var/lib/mercury'),
    `the drop-in must add only what it is for, but ReadWritePaths is "${rw}"`);

  // The point of the split is that the DEFAULT stays strict. If the socket were added to the main
  // unit this test would pass while the hardening was quietly gone.
  for (const unit of ['mercury.service', 'mercury-worker.service']) {
    const text = readFileSync(join(DEPLOY, unit), 'utf8');
    assert.match(text, /^ProtectSystem=strict$/m, `${unit} must keep ProtectSystem=strict`);
    assert.doesNotMatch(text, /docker\.sock/, `${unit} must not grant docker access by default`);
    assert.match(text, /^TimeoutStopSec=\d+$/m, `${unit} must bound shutdown (issue #51/#52)`);
  }
  // Discoverability: an opt-in nobody can find is equivalent to no support at all.
  assert.match(README, /mercury-worker-sandbox\.conf/, 'the guide must name the drop-in');
});
