import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFleetDb } from '../db.ts';

// Migration v4 adds host_version and host_api to host_probe with ALTER TABLE. Fresh databases never
// exercise that path -- they CREATE the table with the columns already present -- so every test in the
// suite passing says nothing about whether an operator's existing fleet.db survives the upgrade.
//
// This matters more than a typical migration test because host_probe is a CACHE: a failure here would
// be tempting to shrug off, but a failed migration aborts openFleetDb() entirely, so Fleet would not
// start at all over a table it could legitimately rebuild.

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), name)), 'fleet.db');
}

test('v4 upgrades an existing database and NULL-fills rows written before it existed', () => {
  const path = tempFile('fleet-mig-');
  try {
    // A database at v4, then wound back to v3 the way an operator's disk actually looks: the columns
    // gone and the version row removed. Dropping the columns rather than hand-writing the v3 schema
    // keeps this honest -- if v1's CREATE TABLE changes, this stops representing v3 and says so.
    const first = openFleetDb(path);
    const db = first.db;
    db.exec(`INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
             VALUES ('old', 'http://h:1', 'ref', 1, '{}', '[]', '[]', '2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO host_probe (host_id, outcome, detail, probed_at)
             VALUES ('old', 'ok', NULL, '2026-01-01T00:00:00Z')`);
    db.exec('ALTER TABLE host_probe DROP COLUMN host_version');
    db.exec('ALTER TABLE host_probe DROP COLUMN host_api');
    db.exec('DELETE FROM fleet_meta WHERE version = 4');
    db.close();

    // Re-open: this is the upgrade an operator experiences.
    const second = openFleetDb(path);
    try {
      assert.ok(second.appliedVersions.includes(4),
        `v4 did not re-apply; applied ${JSON.stringify(second.appliedVersions)}`);
      const row = second.db
        .prepare('SELECT outcome, host_version, host_api FROM host_probe WHERE host_id = ?')
        .get('old') as { outcome: string; host_version: string | null; host_api: number | null } | undefined;
      assert.ok(row, 'the pre-existing probe row was lost by the upgrade');
      assert.equal(row.outcome, 'ok', 'the upgrade must not disturb recorded data');
      // NULL, not 0. A zero here would read as "incompatible host" and remove a working host from
      // rotation the moment Fleet restarts -- the exact failure the probe logic is written to avoid.
      assert.equal(row.host_version, null, 'host_version must be NULL for a row predating the column');
      assert.equal(row.host_api, null, 'host_api must be NULL, not 0, for a row predating the column');
    } finally { second.db.close(); }
  } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
});

test('a second open does not re-apply v4', () => {
  const path = tempFile('fleet-mig2-');
  try {
    const a = openFleetDb(path);
    a.db.close();
    const b = openFleetDb(path);
    assert.deepEqual(b.appliedVersions, [], 're-opening an up-to-date database must apply nothing');
    b.db.close();
  } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
});

test('host_probe stays a cache: dropping it costs no host data', () => {
  // The schema comment claims host_probe is rebuildable and hosts is truth. That claim is what makes
  // a v4 failure survivable in principle, so it is worth pinning rather than leaving in prose.
  const path = tempFile('fleet-mig3-');
  try {
    const opened = openFleetDb(path);
    opened.db.exec(`INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
                    VALUES ('keep', 'http://h:1', 'ref', 1, '{}', '[]', '[]', '2026-01-01T00:00:00Z')`);
    opened.db.exec('DROP TABLE host_probe');
    const left = opened.db.prepare('SELECT id FROM hosts').all() as Array<{ id: string }>;
    assert.deepEqual(left.map((r) => r.id), ['keep'], 'losing the cache must not lose the registry');
    opened.db.close();
  } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
});
