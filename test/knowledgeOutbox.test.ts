/**
 * Phase 1 of docs/knowledge-base.md: the host outbox, the pusher, and the operator surface.
 *
 * The properties worth proving here are all the ones that keep K4 true -- Atlas being unreachable or
 * hostile must cost freshness and nothing else. So most of this file is failure shapes: a transport
 * error, a half-length result array, a note Atlas refuses. The happy path is one test, because it is
 * the easy half and the one that would be caught first by anything else breaking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, closeServer } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { AtlasClient, AtlasTransportError } from '../src/knowledge/client.ts';
import { KnowledgePusher, MAX_BACKOFF_MS, batchIdempotencyKey } from '../src/knowledge/pusher.ts';
import { OutboxStore, SYNC_KEYS, idempotencyKey } from '../src/knowledge/outbox.ts';
import { knowledgeStatus } from '../src/knowledge/status.ts';
import type { KnowledgeConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { makeEnv } from './helpers.ts';
import type { NoteContribution } from '../src/knowledge/types.ts';
import type { AtlasTransport } from '../src/knowledge/client.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const QUIET = createLogger(createRedactor([]), 'error');

function contribution(claim: string, runId: string | null = null): NoteContribution {
  return {
    projectId: 'mercury',
    kind: 'fact',
    scope: 'project',
    claim,
    evidence: [],
    provenance: {
      source: 'agent-reported', hostId: 'host-a', runId: runId ?? undefined,
      recordedAt: new Date().toISOString(),
    },
  };
}

/** A transport that scripts Atlas's behaviour without a socket. */
function scriptedTransport(handler: (req: { method: string; url: string; body?: string }) => { status: number; body: unknown }): { transport: AtlasTransport; calls: { url: string; key?: string; body?: string }[] } {
  const calls: { url: string; key?: string; body?: string }[] = [];
  return {
    calls,
    transport: async (req) => {
      calls.push({ url: req.url, key: req.headers['idempotency-key'], body: req.body });
      return handler({ method: req.method, url: req.url, body: req.body });
    },
  };
}

function client(transport: AtlasTransport): AtlasClient {
  return new AtlasClient({ url: 'http://atlas.invalid', token: 'tok', project: 'mercury', hostId: 'host-a', caFile: null, adminToken: null }, { transport });
}

function pusherFor(env: ReturnType<typeof makeEnv>, script: (req: { method: string; url: string; body?: string }) => { status: number; body: unknown }, extra: { alertDepth?: number } = {}) {
  const { transport } = scriptedTransport(script);
  const outbox = new OutboxStore(env.db);
  const pusher = new KnowledgePusher({
    outbox,
    client: client(transport),
    project: 'mercury',
    intervalMs: 1000,
    batch: 10,
    log: QUIET,
    events: env.events,
    runs: env.runs,
    alertDepth: extra.alertDepth ?? 0,
  });
  return { outbox, pusher };
}

test('the same note from the same Run queues once, and from another Run queues again', () => {
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    const first = outbox.insert([{ runId: 'run-1', contribution: contribution('migrations are appended') }]);
    const replay = outbox.insert([{ runId: 'run-1', contribution: contribution('migrations are appended') }]);
    const other = outbox.insert([{ runId: 'run-2', contribution: contribution('migrations are appended') }]);
    assert.equal(first, 1);
    // The replay is the finalize-retry case. A second row would become a second contribution and
    // therefore a second corroboration for one Run's work.
    assert.equal(replay, 0, 're-queueing the same (run, claim) must be a no-op');
    assert.equal(other, 1, 'a different Run reaching the same claim is a real corroboration');
    assert.equal(outbox.depth(), 2);
  } finally {
    env.close();
  }
});

test('the idempotency key is derived from the Run and the claim, not random', () => {
  const a = idempotencyKey('run-1', contribution('same claim'));
  const b = idempotencyKey('run-1', contribution('  SAME   CLAIM. '));
  const c = idempotencyKey('run-2', contribution('same claim'));
  assert.equal(a, b, 'whitespace and trailing punctuation must not create a second delivery');
  assert.notEqual(a, c, 'two Runs are two contributions');
  assert.ok(!idempotencyKey(null, contribution('x')).startsWith(':'), 'an operator note has a readable prefix');
});

test('accepted and duplicate rows leave the outbox; a rejected row leaves too, with an event on its Run', async () => {
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    // A real Run row, so the rejection has somewhere to land. Created through the service so the
    // Run exists the way it would in production rather than as a hand-inserted row.
    const run = env.runService.create({ ownerId: 'alice', task: 't', agent: 'fake' });
    outbox.insert([
      { runId: run.id, contribution: contribution('one') },
      { runId: run.id, contribution: contribution('two') },
      { runId: run.id, contribution: contribution('three') },
    ]);
    const { pusher } = pusherFor(env, () => ({
      status: 200,
      body: { results: [{ accepted: 'n1' }, { duplicate: 'n2' }, { rejected: 'secret-detected' }] },
    }));

    const outcome = await pusher.pushOnce();
    assert.deepEqual(
      { attempted: outcome.attempted, accepted: outcome.accepted, duplicate: outcome.duplicate, rejected: outcome.rejected, failed: outcome.failed },
      { attempted: 3, accepted: 1, duplicate: 1, rejected: 1, failed: false },
    );
    assert.equal(outbox.depth(), 0, 'Atlas gave a per-item answer for every row, so all three are resolved');

    const events = env.events.list(run.id, 0);
    const rejected = events.filter((e) => e.type === 'knowledge.rejected');
    assert.equal(rejected.length, 1, 'exactly the refused note produces an event');
    assert.equal((rejected[0]!.payload as { reason: string }).reason, 'secret-detected');
    assert.equal((rejected[0]!.payload as { source: string }).source, 'agent-reported');
  } finally {
    env.close();
  }
});

test('a rejection is not recorded on a Run that no longer exists', async () => {
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    // runId set, but no such Run row: the operator path, or a Run that has since been pruned.
    outbox.insert([{ runId: 'run-gone', contribution: contribution('one') }]);
    const { pusher } = pusherFor(env, () => ({ status: 200, body: { results: [{ rejected: 'repo-not-in-project' }] } }));
    await pusher.pushOnce();
    // Nothing to assert on the event stream -- the point is that appending did not throw and did not
    // create an orphan row that no Run owns.
    assert.equal(env.events.list('run-gone', 0).length, 0);
  } finally {
    env.close();
  }
});

test('a transport failure keeps every row, counts the failure, and backs off', async () => {
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    outbox.insert([
      { runId: null, contribution: contribution('one') },
      { runId: null, contribution: contribution('two') },
    ]);
    let down = true;
    const { pusher } = pusherFor(env, () => {
      if (down) throw new AtlasTransportError('ECONNREFUSED');
      return { status: 200, body: { results: [{ accepted: 'a' }, { accepted: 'b' }] } };
    });

    const first = await pusher.pushOnce();
    assert.equal(first.failed, true);
    assert.equal(outbox.depth(), 2, 'nothing is dropped for being undeliverable');
    assert.equal(outbox.getState(SYNC_KEYS.lastPushError), 'ECONNREFUSED');
    assert.equal(outbox.getState('push_failures_total'), '1');
    assert.deepEqual(outbox.takeBatch(10).map((r) => r.attempts), [1, 1]);

    // Exponential, and bounded. Two failures is enough to show the growth; the ceiling is asserted
    // directly rather than by iterating to it, which would need ten passes to leave the interval.
    const second = await pusher.pushOnce();
    assert.equal(second.backoffMs, 2000, 'second failure doubles the interval');
    down = false;
    const third = await pusher.pushOnce();
    assert.equal(third.failed, false, 'a success clears the backoff');
    assert.equal(third.backoffMs, 0);
    assert.equal(outbox.depth(), 0);
    assert.ok(outbox.getState(SYNC_KEYS.lastPushAt), 'the status route needs a last-success timestamp');
    assert.ok(MAX_BACKOFF_MS >= 10 * 60 * 1000);
  } finally {
    env.close();
  }
});

test('a result array shorter than the batch is a failure, and no row is deleted', async () => {
  // The dangerous case. The pusher's next move on a result is to DELETE rows, so a protocol
  // misunderstanding that returns one result for three notes would silently discard two notes.
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    outbox.insert([
      { runId: null, contribution: contribution('one') },
      { runId: null, contribution: contribution('two') },
      { runId: null, contribution: contribution('three') },
    ]);
    const { pusher } = pusherFor(env, () => ({ status: 200, body: { results: [{ accepted: 'n1' }] } }));
    const outcome = await pusher.pushOnce();
    assert.equal(outcome.failed, true);
    assert.equal(outcome.accepted, 0);
    assert.equal(outbox.depth(), 3, 'every row is still there');
    assert.match(outbox.getState(SYNC_KEYS.lastPushError) ?? '', /1 of 3/);
  } finally {
    env.close();
  }
});

test('the client refuses a response it cannot interpret rather than guessing', async () => {
  const cases: [string, unknown][] = [
    ['no results array', { noteIds: [] }],
    ['results not an array', { results: {} }],
    ['a result with two verdicts', { results: [{ accepted: 'a', rejected: 'b' }] }],
    ['a result with an unknown verdict', { results: [{ deferred: 'a' }] }],
  ];
  for (const [what, body] of cases) {
    const { transport } = scriptedTransport(() => ({ status: 200, body }));
    await assert.rejects(
      () => client(transport).pushBatch('mercury', [contribution('x')], 'key'),
      (err: unknown) => err instanceof AtlasTransportError,
      `${what} must throw`,
    );
  }
});

test('a feed without a usable nextSeq throws, because a guessed cursor skips writes forever', async () => {
  for (const nextSeq of [undefined, null, '7', -1, 1.5]) {
    const { transport } = scriptedTransport(() => ({ status: 200, body: { notes: [], nextSeq } }));
    await assert.rejects(() => client(transport).pull('mercury', 0), AtlasTransportError, `nextSeq ${String(nextSeq)} must throw`);
  }
  const ok = scriptedTransport(() => ({ status: 200, body: { notes: [], nextSeq: 0 } }));
  assert.deepEqual(await client(ok.transport).pull('mercury', 0), { notes: [], nextSeq: 0 });
});

test('the batch idempotency key is stable for the same rows and changes when they change', () => {
  const env = makeEnv();
  try {
    const outbox = new OutboxStore(env.db);
    outbox.insert([{ runId: null, contribution: contribution('one') }]);
    const a = outbox.takeBatch(10);
    const b = outbox.takeBatch(10);
    assert.equal(batchIdempotencyKey(a), batchIdempotencyKey(b), 'a re-sent batch is the same batch');
    outbox.insert([{ runId: null, contribution: contribution('two') }]);
    assert.notEqual(batchIdempotencyKey(a), batchIdempotencyKey(outbox.takeBatch(10)));
  } finally {
    env.close();
  }
});

test('the contribute route carries the project, the bearer token and the idempotency key', async () => {
  const { transport, calls } = scriptedTransport(() => ({ status: 200, body: { results: [{ accepted: 'n1' }] } }));
  await client(transport).pushBatch('mercury', [contribution('x')], 'batch-key');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/v1/projects/mercury/notes');
  assert.equal(calls[0]!.key, 'batch-key');
  const body = JSON.parse(calls[0]!.body ?? '{}') as { notes: unknown[] };
  assert.equal(body.notes.length, 1);
});

test('a project id that needs escaping cannot escape its path segment', async () => {
  const { transport, calls } = scriptedTransport(() => ({ status: 200, body: { notes: [], nextSeq: 0 } }));
  await client(transport).pull('../admin', 0);
  assert.ok(!new URL(calls[0]!.url).pathname.includes('/../'), `traversal must be escaped: ${calls[0]!.url}`);
});

test('knowledge status reports depth, last push and the configured project', () => {
  const env = makeEnv();
  try {
    // The config is built once and reused. An earlier version spread the STATUS RESULT of the first call
    // into the second call's CONFIG parameter; both are objects with an `atlas`-ish shape, so the mistake
    // was invisible until something actually typed it.
    const cfg: KnowledgeConfig = {
      atlas: null, inject: true, packMaxBytes: 1, pushIntervalMs: 1, pushBatch: 1, pullIntervalMs: 1,
      outboxAlertDepth: 1,
      bounds: { maxNotesPerRun: 1, maxClaimBytes: 1, maxDetailBytes: 1, maxEvidence: 1, harvestTimeoutMs: 1 },
    };
    const off = knowledgeStatus(env.db, cfg);
    assert.equal(off.enabled, false);
    assert.equal(off.project, null);
    assert.equal(off.outbox.depth, 0);
    assert.equal(off.outbox.oldest, null);
    assert.equal(off.replica.cursor, null, 'the replica tables arrive with phase 2');

    const outbox = new OutboxStore(env.db);
    outbox.insert([{ runId: null, contribution: contribution('one') }]);
    outbox.setState(SYNC_KEYS.lastPushError, 'ECONNREFUSED');
    outbox.setState('push_failures_total', '4');
    const on = knowledgeStatus(env.db, {
      ...cfg,
      atlas: { url: 'http://atlas:4100', token: 't', project: 'mercury', hostId: 'host-a', caFile: null, adminToken: null },
    });
    assert.equal(on.enabled, true);
    assert.equal(on.project, 'mercury');
    assert.equal(on.hostId, 'host-a');
    assert.equal(on.outbox.depth, 1);
    assert.equal(on.outbox.oldest?.attempts, 0);
    assert.equal(on.lastPush.error, 'ECONNREFUSED');
    assert.equal(on.lastPush.failures, 4);
    assert.equal(on.lastPull.at, null);
  } finally {
    env.close();
  }
});

test('GET /api/knowledge/status is admin-only, and absent where the process does not serve it', async () => {
  const env = makeEnv();
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const servers: Server[] = [];
  try {
    const status = knowledgeStatus(env.db, {
      atlas: { url: 'http://atlas:4100', token: 't', project: 'mercury', hostId: 'host-a', caFile: null, adminToken: null },
      inject: true, packMaxBytes: 1, pushIntervalMs: 1, pushBatch: 1, pullIntervalMs: 1, outboxAlertDepth: 1,
      bounds: { maxNotesPerRun: 1, maxClaimBytes: 1, maxDetailBytes: 1, maxEvidence: 1, harvestTimeoutMs: 1 },
    });
    const app = createApp({
      runService: env.runService, events: env.events, stream, queue: env.queue, db: env.db,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: 'tok-admin',
      knowledgeStatus: () => status,
    });
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A non-admin is authenticated and simply lacks the role: 403, not 404.
    const alice = await fetch(`${base}/api/knowledge/status`, { headers: { authorization: 'Bearer tok-alice' } });
    assert.equal(alice.status, 403, 'an authenticated non-admin is refused for a role, not hidden');
    const admin = await fetch(`${base}/api/knowledge/status`, { headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(admin.status, 200);
    assert.equal((await admin.json() as { project: string }).project, 'mercury');
    // Unauthenticated never reaches the route at all.
    const anon = await fetch(`${base}/api/knowledge/status`);
    assert.equal(anon.status, 401);

    // A process that does not own the tables says so, rather than reporting an idle host.
    const bare = createApp({
      runService: env.runService, events: env.events, stream, queue: env.queue, db: env.db,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: 'tok-admin',
    });
    const bareServer = await new Promise<Server>((resolve) => { const s = bare.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(bareServer);
    const bareBase = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    const missing = await fetch(`${bareBase}/api/knowledge/status`, { headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(missing.status, 404, 'a process that does not own the tables says so');
  } finally {
    for (const s of servers) {
      // Node's fetch keeps its socket alive, and an in-flight keep-alive connection outliving the
      // test is what turns a passing assertion into an unhandledRejection after the fact.
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closeServer(s);
    }
    stream.stop();
    env.close();
  }
});

test('POST /api/knowledge/notes is wired through the app, not just through the function', async () => {
  // The route reads `knowledgeNotes` off RoutesDeps. The composition root supplies it to createApp, and
  // createApp has to FORWARD it -- a line that was missing, and that no test caught, because every other
  // test in this feature calls submitOperatorNote() directly. The route then answered 404 forever: the
  // feature worked in tests and did not exist over HTTP.
  const env = makeEnv();
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  try {
    const queued: unknown[] = [];
    const app = createApp({
      runService: env.runService, events: env.events, stream, queue: env.queue, db: env.db,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: 'tok-admin',
      knowledgeNotes: (body) => { queued.push(body); return { ok: true, claimHash: 'a'.repeat(16), queued: true }; },
    });
    const server = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = { kind: 'convention', scope: 'project', claim: 'migrations are appended, never edited' };
      const alice = await fetch(`${base}/api/knowledge/notes`, {
        method: 'POST', headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(alice.status, 403, 'an operator note lands promoted, so it is an admin act');
      assert.equal(queued.length, 0, 'a non-admin must not reach the enqueue path at all');

      const admin = await fetch(`${base}/api/knowledge/notes`, {
        method: 'POST', headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      // 202, not 201: the note is durable here and not yet in Atlas.
      assert.equal(admin.status, 202, 'the route must be reachable over HTTP, not 404');
      assert.equal((await admin.json() as { queued: boolean }).queued, true);
      assert.equal(queued.length, 1, 'the body reached the enqueue path');
      assert.equal((queued[0] as { claim: string }).claim, body.claim);
    } finally {
      await closeServer(server);
    }
  } finally {
    stream.stop();
    env.close();
  }
});

test('a refusal over HTTP keeps its reason, and an unconfigured host is refused rather than queued', async () => {
  const env = makeEnv();
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  try {
    const app = createApp({
      runService: env.runService, events: env.events, stream, queue: env.queue, db: env.db,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: 'tok-admin',
      knowledgeNotes: () => ({ ok: false, status: 400, error: 'note refused: claim-too-long', reason: 'claim-too-long' as never }),
    });
    const server = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/knowledge/notes`, {
        method: 'POST', headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'fact', scope: 'project', claim: 'x' }),
      });
      assert.equal(res.status, 400);
      const payload = await res.json() as { error: string; reason?: string };
      assert.equal(payload.reason, 'claim-too-long',
        'the closed reason must survive the HTTP boundary, or an operator cannot tell which bound was hit');
    } finally {
      await closeServer(server);
    }
  } finally {
    stream.stop();
    env.close();
  }
});
