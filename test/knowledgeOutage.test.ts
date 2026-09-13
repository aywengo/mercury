/**
 * The outage proof for Phase 1 (docs/knowledge-base.md section 16 phase 1, K4).
 *
 * "Proven by the contract test with Atlas stopped and restarted." The property under test is not that
 * pushing works -- that is a happy path. It is that a host which cannot reach its knowledge service
 * LOSES NOTHING: notes accumulate durably, the failure is visible to an operator, and the backlog drains
 * by itself when the service returns.
 *
 * Atlas runs as a real child process over real HTTP rather than as an injected transport, because the
 * failure being exercised is the process boundary itself. A scripted transport can simulate a non-2xx
 * answer; it cannot simulate a service that is not there, which is the case the outbox exists for, and
 * it cannot come back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OutboxStore, SYNC_KEYS } from '../src/knowledge/outbox.ts';
import { AtlasClient } from '../src/knowledge/client.ts';
import { KnowledgePusher } from '../src/knowledge/pusher.ts';
import { knowledgeStatus } from '../src/knowledge/status.ts';
import { submitOperatorNote } from '../src/knowledge/operator.ts';
import { normalizeRepoIdentity } from '../src/knowledge/identity.ts';
import { DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';
import type { KnowledgeConfig } from '../src/config.ts';
import { makeEnv, tempDir } from './helpers.ts';

const REPO = resolve(import.meta.dirname, '..');
const ADMIN = 'outage-admin-token-0123456789';
const CONTRIBUTOR = 'outage-contributor-token-01234';
const PROJECT = 'mercury';
const REPO_URL = 'github.com/aywengo/mercury';

const QUIET = { info() {}, warn() {}, error() {} } as never;

interface Atlas { url: string; stop(): Promise<void> }

async function startAtlas(dir: string): Promise<Atlas> {
  const contributorsFile = join(dir, 'contributors.json');
  writeFileSync(contributorsFile, JSON.stringify({
    [CONTRIBUTOR]: { hostId: 'host-a', projects: [PROJECT] },
  }), { mode: 0o600 });

  const child: ChildProcess = spawn(process.execPath, [join(REPO, 'atlas/cli.ts'), 'serve'], {
    cwd: REPO,
    env: {
      ...process.env,
      ATLAS_DB: join(dir, 'atlas.db'),
      ATLAS_BIND_HOST: '127.0.0.1',
      ATLAS_PORT: '0',
      ATLAS_ADMIN_TOKEN: ADMIN,
      ATLAS_CONTRIBUTORS_FILE: contributorsFile,
      ATLAS_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('atlas did not report a listen URL within 20s')), 20_000);
    const onData = (c: Buffer): void => {
      const m = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(c.toString());
      if (m) { clearTimeout(timer); done(m[1]!); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`atlas exited early (${code})`)); });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  };
  return { url, stop };
}

function hostConfig(url: string): KnowledgeConfig {
  return {
    atlas: { url, token: CONTRIBUTOR, project: PROJECT, hostId: 'host-a', caFile: null, adminToken: ADMIN },
    inject: true, packMaxBytes: 65536, pushIntervalMs: 30_000, pushBatch: 100, pullIntervalMs: 30_000, retiredRetentionMs: 604_800_000,
    outboxAlertDepth: 0, bounds: DEFAULT_BOUNDS,
  };
}

function pusherFor(db: DatabaseSync, url: string, adminToken: string | null = ADMIN): KnowledgePusher {
  const config = hostConfig(url);
  const atlas = config.atlas!;
  return new KnowledgePusher({
    outbox: new OutboxStore(db),
    client: new AtlasClient(atlas),
    ...(adminToken ? { adminClient: new AtlasClient({ ...atlas, token: adminToken }) } : {}),
    project: PROJECT,
    intervalMs: 0,
    batch: 100,
    log: QUIET,
  });
}

/** Register the project in Atlas with the admin token, so the contributor's notes pass section 5. */
async function createProject(url: string): Promise<void> {
  const res = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: PROJECT, name: 'Mercury', repoIdentities: [REPO_URL] }),
  });
  assert.ok(res.status === 201 || res.status === 409, `project creation returned ${res.status}`);
}

function operatorNote(claim: string): Record<string, unknown> {
  return { kind: 'convention', scope: 'project', claim };
}

test('notes queued while Atlas is down survive it and drain when it returns', async () => {
  const dir = tempDir('atlas-outage-');
  const env = makeEnv();
  let atlas: Atlas | null = null;
  try {
    atlas = await startAtlas(dir);
    await createProject(atlas.url);
    const outbox = new OutboxStore(env.db);
    const config = hostConfig(atlas.url);

    // Two notes land while the service is up and drain normally.
    for (const claim of ['migrations are appended to MIGRATIONS, never edited', 'run one test file with node --test']) {
      const r = submitOperatorNote(env.db, config, operatorNote(claim));
      assert.ok(r.ok, `operator note refused: ${JSON.stringify(r)}`);
    }
    assert.equal(outbox.depth(), 2, 'both notes are queued durably before anything is sent');
    const first = await pusherFor(env.db, atlas.url).pushOnce();
    assert.equal(first.failed, false, `first pass failed: ${first.lastError ?? ''}`);
    assert.equal(outbox.depth(), 0, 'the outbox drains on success');

    // The service dies.
    await atlas.stop();
    atlas = null;

    // Three more notes are written during the outage. This is the case the outbox exists for: an
    // operator keeps working, and the knowledge they record must not depend on a remote service being up.
    const duringOutage = ['the lease-expiry test is timing sensitive', 'workspace GC runs on its own timer', 'events are appended through EventStore only'];
    for (const claim of duringOutage) {
      const r = submitOperatorNote(env.db, config, operatorNote(claim));
      assert.ok(r.ok, `note refused during an outage: ${JSON.stringify(r)}`);
    }
    assert.equal(outbox.depth(), 3, 'the outage does not stop notes being recorded');

    // A push attempt during the outage keeps every row and records why.
    // A port nothing listens on. Binding port 0 and closing it would race; a refused connection on an
    // unused high port is what an outage looks like from a client, and it fails fast and deterministically.
    const DEAD = 'http://127.0.0.1:1';
    const failed = await pusherFor(env.db, DEAD).pushOnce();
    assert.equal(failed.failed, true, 'an unreachable Atlas is a failed pass');
    assert.equal(outbox.depth(), 3, 'NOTHING is dropped for being undeliverable (K4)');
    const rows = outbox.takeBatch(10);
    assert.ok(rows.every((row) => row.attempts === 1), `every row records an attempt: ${rows.map((r) => r.attempts)}`);
    assert.ok(rows.every((row) => row.lastError), 'every row records the error for the operator');
    assert.equal(new OutboxStore(env.db).getState('push_failures_total'), '1', 'the failure is counted where /metrics can read it');

    // The status surface tells the truth during the outage: depth is what an operator alerts on.
    const duringStatus = knowledgeStatus(env.db, config);
    assert.equal(duringStatus.enabled, true);
    assert.equal(duringStatus.outbox.depth, 3);
    assert.ok(duringStatus.lastPush.error, 'the last error is visible without reading the database');

    // The service comes back on a DIFFERENT port, which is what a restart actually does.
    atlas = await startAtlas(dir);
    await createProject(atlas.url);
    const recovered = await pusherFor(env.db, atlas.url).pushOnce();
    assert.equal(recovered.failed, false, `the backlog did not drain after recovery: ${recovered.lastError ?? ''}`);
    assert.equal(outbox.depth(), 0, 'the outbox is empty once Atlas has everything');

    // Atlas holds all five notes, and the three from the outage are there rather than merely accepted.
    const feed = await fetch(`${atlas.url}/v1/projects/${PROJECT}/notes?since=0&tier=all`, {
      headers: { authorization: `Bearer ${CONTRIBUTOR}` },
    });
    const body = await feed.json() as { notes: { claim: string; tier: string }[] };
    assert.equal(body.notes.length, 5, `expected 5 notes in Atlas, saw ${body.notes.length}`);
    assert.ok(body.notes.every((n) => n.tier === 'promoted'), 'operator notes land promoted');
  } finally {
    if (atlas) await atlas.stop();
    env.close();
  }
});

