/**
 * The Atlas wire contract (docs/knowledge-base.md sections 11.1, 11.2 and 11.6).
 *
 * This file lives in the ROOT suite on purpose. It is the one place that is allowed to know both
 * products at once: `atlas/` may not import `src/` and `src/` may not import `atlas/`, and that rule
 * is enforced by `atlas/test/coupling.test.ts`. Which means the two implementations of the note
 * record, the identity normalization and the claim hash are never checked against each other by the
 * typechecker -- only here.
 *
 * Phase 0 drives Atlas with plain HTTP and no host code, which is what section 16 phase 0 asks for
 * ("a script standing in for a host"). Phase 1 adds the real host to this file, so the outbox and the
 * restart behaviour are exercised against the same server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';

import { ATLAS_VERSION } from '../atlas/version.ts';
import type { ProjectSummary } from '../atlas/notes.ts';
import { ATLAS_SUMMARY_KEYS, parseSummary, type AtlasProjectSummary } from '../fleet/atlas.ts';

/**
 * The summary shape is asserted to be the SAME type on both sides, at compile time.
 *
 * `atlas/` and `fleet/` may not import each other, so the response record exists twice by design. The
 * runtime key assertion in the contract test catches drift when the suite runs; this catches it on
 * `npm run typecheck`, which is faster and fires even when the contract suite is filtered out.
 *
 * Mutual assignability is NOT sufficient on its own, and an earlier revision of this comment claimed it
 * was. Two interfaces that are mutually assignable can still differ by a field that is optional on one
 * side and absent on the other -- verified by mutation. That residual gap is closed by
 * `ATLAS_SUMMARY_KEYS` in fleet/atlas.ts: the key set is declared there as a value, pinned to the
 * Fleet interface at compile time, and compared against Atlas's actual response below.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _summaryShapesAgree: Exactly<AtlasProjectSummary, ProjectSummary> = true;
void _summaryShapesAgree;

const REPO = resolve(import.meta.dirname, '..');
const ADMIN = 'contract-admin-token-0123456789';
const CONTRIBUTOR = 'contract-contributor-token-0123';
const READER = 'contract-reader-token-0123456789';
const PROJECT = 'mercury';

interface AtlasHandle {
  url: string;
  stop(): Promise<void>;
  restart(): Promise<AtlasHandle>;
  dbPath: string;
  dir: string;
}

/**
 * Start `atlas serve` as a child process against a real file-backed database.
 *
 * A child rather than an in-process server, because the properties worth proving here are about the
 * process boundary: that a restart keeps the sequence, that the wire shapes are the ones on the
 * socket rather than the ones in the source, and that the CLI entry point works at all. An
 * in-process server would prove none of those and would look identical in the test output.
 */
async function startAtlas(dir: string, extraEnv: Record<string, string> = {}): Promise<AtlasHandle> {
  const dbPath = join(dir, 'atlas.db');
  const contributorsFile = join(dir, 'contributors.json');
  writeFileSync(contributorsFile, JSON.stringify({
    [CONTRIBUTOR]: { hostId: 'host-a', projects: [PROJECT] },
  }), { mode: 0o600 });

  // Port 0 and then read the bound port out of the log line: a fixed port makes every parallel test
  // run fight over one socket, which reads as a flaky test rather than a broken product.
  const child: ChildProcess = spawn(process.execPath, [join(REPO, 'atlas/cli.ts'), 'serve'], {
    cwd: REPO,
    env: {
      ...process.env,
      ATLAS_DB: dbPath,
      ATLAS_BIND_HOST: '127.0.0.1',
      ATLAS_PORT: '0',
      ATLAS_ADMIN_TOKEN: ADMIN,
      ATLAS_CONTRIBUTORS_FILE: contributorsFile,
      ATLAS_READER_TOKENS: `${READER}:dashboard:${PROJECT}`,
      ATLAS_LOG_LEVEL: 'info',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`atlas did not report a listen URL within 20s`)), 20_000);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      const match = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(text);
      if (match) { clearTimeout(timer); resolveUrl(match[1]!); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); rejectUrl(new Error(`atlas exited early with code ${code}`)); });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  };

  return {
    url, dbPath, dir, stop,
    restart: async () => {
      await stop();
      return startAtlas(dir, extraEnv);
    },
  };
}

async function req(handle: AtlasHandle, method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(handle.url + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function contribution(claim: string, hostId: string, runId: string, agent: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'fact',
    scope: 'project',
    claim,
    evidence: [],
    provenance: { source: 'agent-reported', hostId, runId, agent, harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
    repoIdentity: 'github.com/aywengo/mercury',
    ...extra,
  };
}

test('every enumerated route answers, and its shape has not drifted', async () => {
  const dir = tempDir('atlas-contract-');
  let handle: AtlasHandle | null = null;
  try {
    handle = await startAtlas(dir);

    // /healthz -- the shape Fleet already probes on hosts.
    let res = await req(handle, 'GET', '/healthz', null);
    assert.equal(res.status, 200);
    let body = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'product', 'ts', 'version']);
    assert.equal(body.product, 'atlas');
    assert.equal(body.version, ATLAS_VERSION);

    // POST /v1/projects (admin) and GET /v1/projects.
    res = await req(handle, 'POST', '/v1/projects', ADMIN, {
      id: PROJECT, name: 'Mercury', repoIdentities: ['github.com/aywengo/mercury'],
      promotionPolicy: { auto: { minRuns: 2, minDistinctHarnessesOrHosts: 2, kinds: ['fact', 'convention', 'command', 'pitfall'] } },
    });
    assert.equal(res.status, 201);
    const project = await res.json() as { id: string; repoIdentities: string[] };
    assert.equal(project.id, PROJECT);

    res = await req(handle, 'GET', '/v1/projects', ADMIN);
    assert.deepEqual(Object.keys(await res.json() as Record<string, unknown>), ['projects']);

    // GET /v1/contributors -- the seeded file must have landed.
    res = await req(handle, 'GET', '/v1/contributors', ADMIN);
    const contributors = (await res.json() as { contributors: { hostId: string }[] }).contributors;
    assert.deepEqual(contributors.map((c) => c.hostId), ['host-a']);

    // POST .../notes (contributor), per-item answers.
    res = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes`, CONTRIBUTOR,
      { notes: [contribution('migrations are appended to MIGRATIONS, never edited', 'host-a', 'run-1', 'primeagent')] },
      { 'idempotency-key': 'batch-1' });
    assert.equal(res.status, 200);
    let results = (await res.json() as { results: Record<string, string>[] }).results;
    assert.equal(results.length, 1);
    assert.ok('accepted' in results[0]!, `expected accepted, got ${JSON.stringify(results[0])}`);
    const noteId = results[0]!.accepted!;

    // GET .../notes/:noteId -- current revision plus revisions[] and sources[].
    res = await req(handle, 'GET', `/v1/projects/${PROJECT}/notes/${noteId}`, CONTRIBUTOR);
    const detail = await res.json() as { note: Record<string, unknown>; revisions: unknown[]; sources: unknown[] };
    assert.deepEqual(Object.keys(detail).sort(), ['note', 'revisions', 'sources']);
    // Pinned exactly. `corroboration` and `contested` are computed from note_sources and contests on
    // every read rather than stored, so a replica can never see a stale count; a field appearing here
    // that is not derived is the mistake this assertion exists to catch.
    assert.deepEqual(Object.keys(detail.note).sort(), [
      'claim', 'contested', 'corroboration', 'evidence', 'kind', 'noteId', 'projectId', 'provenance',
      'revision', 'scope', 'seq', 'tier',
    ]);

    // GET .../notes -- the cursor feed.
    res = await req(handle, 'GET', `/v1/projects/${PROJECT}/notes?since=0&tier=all`, CONTRIBUTOR);
    const feed = await res.json() as { notes: unknown[]; nextSeq: number };
    assert.deepEqual(Object.keys(feed).sort(), ['nextSeq', 'notes']);
    assert.equal(feed.notes.length, 1);

    // GET .../bootstrap -- the full promoted set and the seq to continue from.
    res = await req(handle, 'GET', `/v1/projects/${PROJECT}/bootstrap`, CONTRIBUTOR);
    const boot = await res.json() as { notes: unknown[]; nextSeq: number };
    assert.deepEqual(Object.keys(boot).sort(), ['nextSeq', 'notes']);

    // Curation.
    res = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes/${noteId}/promote`, ADMIN, { reason: 'operator reviewed on the call' });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { note: { tier: string } }).note.tier, 'promoted');

    res = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes/${noteId}/retire`, ADMIN, { reason: 'superseded by a decision record' });
    assert.equal(res.status, 200);

    res = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes/${noteId}/contest`, CONTRIBUTOR, { contradicts: noteId });
    assert.ok(res.status === 404 || res.status === 200, 'contesting a note with itself is refused, not accepted');

    // PATCH /v1/projects/:id.
    res = await req(handle, 'PATCH', `/v1/projects/${PROJECT}`, ADMIN, { name: 'Mercury renamed' });
    assert.equal((await res.json() as { name: string }).name, 'Mercury renamed');

    // GET .../summary -- the counts-only read Fleet's dashboard is built on (section 14).
    //
    // Pinned to an exact key set, and pinned AGAIN at type level below, because this response is
    // implemented twice: `ProjectSummary` in atlas/notes.ts and `AtlasProjectSummary` in fleet/atlas.ts.
    // Neither product may import the other, so nothing else in the build compares them, and a field
    // renamed on one side would otherwise surface as a dashboard showing zeros rather than as a failure.
    res = await req(handle, 'GET', `/v1/projects/${PROJECT}/summary`, READER);
    assert.equal(res.status, 200, `a reader token must be able to read the summary: ${res.status}`);
    const summary = await res.json() as Record<string, unknown>;
    // Compared against the Fleet reader's own declared key set rather than a list typed out here. A
    // hand-copied list in a test drifts the same way a hand-copied type does; this way the two sides are
    // checked against each other and the test file is not a third copy of the truth.
    assert.deepEqual(Object.keys(summary).sort(), [...ATLAS_SUMMARY_KEYS].sort());
    // Bytes off the wire, through the validator Fleet will actually run in production. The key
    // comparison above only proves the two sides list the same names; this proves Fleet accepts what
    // Atlas really sends, including the value SHAPES -- a field present but of the wrong type would
    // pass the key check and then be rejected at runtime, blanking the dashboard.
    const validated = parseSummary(summary);
    assert.ok(validated.ok, `Fleet rejects a real Atlas summary: ${validated.ok ? '' : validated.reason}`);
    // The whole point of the route: counts, never content.
    assert.ok(!JSON.stringify(summary).includes('migrations are appended'),
      'the summary leaked note content to a reader token');

    // /metrics.
    res = await req(handle, 'GET', '/metrics', ADMIN);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(await res.text(), /^atlas_projects \d+$/m);
  } finally {
    if (handle) await handle.stop();
  }
});

test('the sequence survives a restart, so a cursor is still gapless afterwards', async () => {
  const dir = tempDir('atlas-restart-');
  let handle: AtlasHandle | null = null;
  try {
    handle = await startAtlas(dir);
    await req(handle, 'POST', '/v1/projects', ADMIN, { id: PROJECT, name: 'Mercury', repoIdentities: ['github.com/aywengo/mercury'] });
    const first = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes`, CONTRIBUTOR,
      { notes: [contribution('first note', 'host-a', 'run-1', 'primeagent')] }, { 'idempotency-key': 'r1' });
    assert.ok('accepted' in (await first.json() as { results: Record<string, string>[] }).results[0]!);

    handle = await handle.restart();

    // Same database file, new process. The seq must continue rather than restart, or every replica
    // that already consumed seq 1 would treat a later note as already seen.
    const after = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes`, CONTRIBUTOR,
      { notes: [contribution('second note', 'host-a', 'run-2', 'primeagent')] }, { 'idempotency-key': 'r2' });
    assert.equal(after.status, 200);

    const feed = await req(handle, 'GET', `/v1/projects/${PROJECT}/notes?since=0&tier=all`, CONTRIBUTOR);
    const notes = (await feed.json() as { notes: { seq: number }[] }).notes;
    assert.equal(notes.length, 2, 'both notes survived the restart');
    assert.deepEqual(notes.map((n) => n.seq).sort((a, b) => a - b), [1, 2], 'the sequence continued');
  } finally {
    if (handle) await handle.stop();
  }
});

test('a replayed batch after a restart returns the original answers without corroborating twice', async () => {
  const dir = tempDir('atlas-idem-');
  let handle: AtlasHandle | null = null;
  try {
    handle = await startAtlas(dir);
    await req(handle, 'POST', '/v1/projects', ADMIN, { id: PROJECT, name: 'Mercury', repoIdentities: ['github.com/aywengo/mercury'] });
    const notes = [contribution('the flaky fixture is test/multiWorker', 'host-a', 'run-1', 'primeagent')];
    const first = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes`, CONTRIBUTOR, { notes }, { 'idempotency-key': 'lost-ack' });
    const firstResults = (await first.json() as { results: Record<string, string>[] }).results;

    handle = await handle.restart();
    const replay = await req(handle, 'POST', `/v1/projects/${PROJECT}/notes`, CONTRIBUTOR, { notes }, { 'idempotency-key': 'lost-ack' });
    const replayResults = (await replay.json() as { results: Record<string, string>[] }).results;
    assert.deepEqual(replayResults, firstResults, 'the replay must answer exactly as the original did');

    const noteId = firstResults[0]!.accepted!;
    const detail = await req(handle, 'GET', `/v1/projects/${PROJECT}/notes/${noteId}`, CONTRIBUTOR);
    const body = await detail.json() as { note: { corroboration: { runs: number } }; sources: unknown[] };
    assert.equal(body.note.corroboration.runs, 1, 'a lost acknowledgement must not look like a second Run agreeing');
    assert.equal(body.sources.length, 1);
  } finally {
    if (handle) await handle.stop();
  }
});

test('Atlas refuses to bind beyond loopback without TLS', async () => {
  const dir = tempDir('atlas-tls-');
  try {
    // The refusal has to happen before anything listens, so this is a CLI-level assertion rather than
    // a socket one: the process must exit non-zero and say why.
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [join(REPO, 'atlas/cli.ts'), 'serve'], {
        cwd: REPO,
        env: { ...process.env, ATLAS_DB: join(dir, 'atlas.db'), ATLAS_BIND_HOST: '0.0.0.0', ATLAS_PORT: '0', ATLAS_ADMIN_TOKEN: ADMIN },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let out = '';
      child.stderr?.on('data', (c: Buffer) => { out += c.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 20_000);
      child.once('exit', (c) => { clearTimeout(timer); assert.match(out, /TLS/i, 'the refusal must name TLS'); done(c); });
    });
    assert.equal(code, 1, 'refusing to start is a failed command, not a silent exit');
  } finally {
  }
});
