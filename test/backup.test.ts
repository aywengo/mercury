import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// deploy/backup.sh -- a backup that silently omits the WAL is worse than no backup, so the
// behaviour that matters is the FAILURE path: refusing to run rather than producing a plausible
// looking file (issue #69).
import { execFileSync } from 'node:child_process';


/**
 * A PATH containing only the coreutils backup.sh needs, and NOT sqlite3.
 *
 * An empty PATH is not usable: `set -euo pipefail` would abort at the first `mkdir`/`date` and the
 * test would pass for the wrong reason -- it would prove the script fails, not that it refuses on
 * account of sqlite3. So we give it a working shell environment with exactly one tool missing.
 */
function pathWithoutSqlite3(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['date', 'mkdir', 'ls', 'tail', 'rm', 'bash']) {
    const found = execFileSync('bash', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  return bin;
}

const BACKUP_SH = join(import.meta.dirname, '..', 'deploy', 'backup.sh');

function runBackup(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [BACKUP_SH], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('backup.sh refuses to run without sqlite3 instead of falling back to cp (issue #69)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-backup-nosqlite-'));
  const db = join(dir, 'mercury.db');
  writeFileSync(db, 'not really a database, and that is the point');
  const backupDir = join(dir, 'backups');
  // PATH without any directory containing sqlite3, so `command -v sqlite3` fails.
  const res = runBackup({ PATH: pathWithoutSqlite3(dir), MERCURY_DB: db, BACKUP_DIR: backupDir });

  assert.notEqual(res.code, 0, 'must fail loudly, not exit 0 with a bad file');
  assert.match(res.out, /sqlite3 is required/, 'the error must name the missing dependency');
  assert.match(res.out, /WAL/, 'and explain WHY cp is not acceptable, so nobody re-adds it');
  // The decisive part: no backup file may exist. Under the old `cp` fallback this exited 0 and
  // left a file that looked like a backup.
  const written = existsSync(backupDir) ? readdirSync(backupDir) : [];
  assert.deepEqual(written, [], `no backup may be written, found ${JSON.stringify(written)}`);
});

test('backup.sh produces a verified backup when sqlite3 is available (issue #69)', async (t) => {
  let sqlite3: string;
  try {
    sqlite3 = execFileSync('bash', ['-lc', 'command -v sqlite3'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('sqlite3 not installed on this host');
    return;
  }
  assert.ok(sqlite3, 'sqlite3 present');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-backup-ok-'));
  const db = join(dir, 'mercury.db');
  const backupDir = join(dir, 'backups');
  // Build a real WAL-mode database through the app's own driver, so the fixture matches what the
  // script actually has to back up.
  const { openDatabase } = await import('../src/db/database.ts');
  const handle = openDatabase(db);
  handle.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
  handle.close();

  const res = runBackup({
    PATH: `${sqlite3.replace(/\/sqlite3$/, '')}:/usr/bin:/bin`,
    MERCURY_DB: db,
    BACKUP_DIR: backupDir,
  });
  assert.equal(res.code, 0, `backup should succeed: ${res.out}`);
  assert.match(res.out, /written and verified/);
  const made = readdirSync(backupDir).filter((f) => f.endsWith('.db'));
  assert.equal(made.length, 1, 'exactly one backup file');
});

test('backup.sh has no cp fallback and verifies integrity (issue #69)', () => {
  // Source guard: the cp line is the specific thing that must not come back, and a future
  // "make it work without sqlite3" change would reintroduce a silent data-loss path.
  const src = readFileSync(BACKUP_SH, 'utf8');
  const code = src.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(code, /^\s*cp\s+"\$DB"/m, 'the `cp "$DB"` fallback must not return');
  assert.match(code, /PRAGMA integrity_check/, 'the backup must be verified after writing');
  assert.match(code, /exit 1/, 'and must fail loudly when it cannot back up safely');
});

test('a failed .backup leaves no partial file behind (issue #69 review)', () => {
  // sqlite3 exists, but the database is unreadable, so .backup itself fails partway. `set -e`
  // would exit and leave a truncated $OUT named exactly like a good backup, which retention would
  // then keep.
  const dir = mkdtempSync(join(tmpdir(), 'mercury-backup-partial-'));
  const db = join(dir, 'mercury.db');
  // A file that is not a database: sqlite3 opens it, then fails on the backup step.
  writeFileSync(db, 'this is definitely not an sqlite database file');
  const backupDir = join(dir, 'backups');
  let sqlite3: string;
  try {
    sqlite3 = execFileSync('bash', ['-lc', 'command -v sqlite3'], { encoding: 'utf8' }).trim();
  } catch {
    return; // no sqlite3 to fail with
  }
  const res = runBackup({
    PATH: `${sqlite3.replace(/\/sqlite3$/, '')}:/usr/bin:/bin`,
    MERCURY_DB: db,
    BACKUP_DIR: backupDir,
  });
  assert.notEqual(res.code, 0, 'a failed backup must exit non-zero');
  const left = existsSync(backupDir) ? readdirSync(backupDir) : [];
  assert.deepEqual(left, [],
    `a failed backup must leave nothing behind, found ${JSON.stringify(left)}`);
});

test('the restore chowns the database to the service user (issue #69 review)', () => {
  // `sudo cp` leaves the file root-owned while both units run as User=mercury.
  const readme = readFileSync(join(import.meta.dirname, '..', 'deploy', 'README.md'), 'utf8');
  const restore = readme.slice(readme.indexOf('## Restore'));
  const cpIdx = restore.indexOf('sudo cp ');
  const chownIdx = restore.indexOf('chown mercury:mercury /var/lib/mercury/mercury.db');
  assert.ok(chownIdx > cpIdx,
    'the restore must chown the database to mercury after copying it as root');
});
