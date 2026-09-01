import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

// deploy/README.md path consistency (issue #70).
// The bug here was documentation drift, not code: the app defaults to a RELATIVE ./mercury.db
// (resolved against WorkingDirectory=/opt/mercury) while the backup cron read
// /var/lib/mercury/mercury.db. A deploy that followed the guide backed up a file the application
// never writes to, and nothing reported the disagreement. So the guard is a test that the paths in
// the guide agree with each other.
import { readFileSync } from 'node:fs';

const README = readFileSync(join(import.meta.dirname, '..', 'deploy', 'README.md'), 'utf8');
const UNITS = ['mercury.service', 'mercury-worker.service']
  .map((f) => readFileSync(join(import.meta.dirname, '..', 'deploy', f), 'utf8'));

/** Every distinct /...db path mentioned in a slice of the guide. */
function dbPaths(text: string): string[] {
  return [...new Set(text.match(/\/[A-Za-z0-9._/-]*\.db/g) ?? [])];
}

test('the ops guide names one database path everywhere it appears (issue #70)', () => {
  const env = README.match(/MERCURY_DB=(\S+)/)?.[1];
  assert.ok(env, 'the guide must state MERCURY_DB explicitly; the app default is relative');
  assert.ok(env.startsWith('/'), `MERCURY_DB must be absolute, got ${env}`);

  const cron = README.match(/^30 2 .*$/m)?.[0] ?? '';
  assert.ok(cron, 'the backup cron line must be present');
  const cronDb = cron.match(/MERCURY_DB=(\S+)/)?.[1];
  assert.equal(cronDb, env, 'backup cron must read the same database the app writes');

  // Restore names two kinds of path: the backup ARCHIVE it reads (under BACKUP_DIR) and the LIVE
  // database it writes. Only the live one must equal MERCURY_DB -- checking every path would fail
  // on the archive, which is a different file by design.
  const restore = README.slice(README.indexOf('## Restore'));
  const cp = restore.match(/cp\s+\S+\s+(\S+\.db)/);
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
