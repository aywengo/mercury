import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { BindingStore, UNKNOWN } from '../bindings.ts';
import { createChildClient } from '../child.ts';
import { recoverPending, refreshStates, submitRun, DispatchError, type DispatchDeps } from '../dispatch.ts';

interface ChildBehaviour {
  /** Drop the response AFTER creating the Run: the request lands, the reply does not. */
  dropResponse?: boolean;
  failWith?: number;
  statusAfter?: string;
  unreachable?: boolean;
}

/**
 * A stand-in child that implements the one behaviour Fleet's safety depends on: Idempotency-Key dedupe
 * scoped to the owner, returning the Run already created. Mercury does exactly this in
 * RunService.create -> findByIdempotencyKey, so the fake must too or the tests prove nothing.
 */
async function fakeChild(behaviour: ChildBehaviour = {}): Promise<{
  url: string; created: { key: string | undefined; runId: string }[]; authSeen: string[];
  close: () => Promise<void>; setStatus: (s: string) => void;
}> {
  const runs = new Map<string, { id: string; status: string }>();
  const byKey = new Map<string, string>();
  const created: { key: string | undefined; runId: string }[] = [];
  const authSeen: string[] = [];
  let status = 'QUEUED';
  let counter = 0;
  const server: Server = createServer((req, res) => {
    authSeen.push(String(req.headers.authorization ?? ''));
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const key = req.headers['idempotency-key'] as string | undefined;
      if (req.method === 'POST' && req.url === '/api/runs') {
        const existing = key ? byKey.get(key) : undefined;
        if (existing) {
          // Dedupe hit: same Run, no new one. This is the branch that prevents a double-spend.
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ runId: existing, status: runs.get(existing)!.status, deduped: true }));
          return;
        }
        const id = `run_${++counter}`;
        runs.set(id, { id, status });
        if (key) byKey.set(key, id);
        created.push({ key, runId: id });
        if (behaviour.dropResponse) {
          // The Run exists. The client will never learn its id from this attempt.
          res.destroy();
          return;
        }
        if (behaviour.failWith) {
          res.writeHead(behaviour.failWith, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'task is required' }));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: id, status }));
        return;
      }
      const m = /^\/api\/runs\/(.+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) {
        const run = runs.get(m[1]!);
        if (!run) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such run' }));
          return;
        }
        // Faithful to GET /api/runs/:runId, which answers { run, skills }. An earlier fake returned a bare
        // run -- the same wrong assumption as the client -- so both agreed and the tests proved nothing.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run: { id: run.id, status: run.status }, skills: [] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: behaviour.unreachable ? 'http://127.0.0.1:1' : `http://127.0.0.1:${port}`,
    created, authSeen,
    setStatus: (s: string) => { status = s; for (const r of runs.values()) r.status = s; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function harness(behaviour: ChildBehaviour = {}) {
  return (async () => {
    const child = await fakeChild(behaviour);
    const { db } = openFleetDb(':memory:');
    const registry = new HostRegistry(db);
    registry.add({ id: 'studio', baseUrl: child.url, credentialRef: 'lan-ref' });
    const bindings = new BindingStore(db);
    const dispatch: DispatchDeps = {
      registry, bindings,
      child: createChildClient({ timeoutMs: 1500 }),
      resolveToken: (ref) => (ref === 'lan-ref' ? 'child-secret-value' : (() => { throw new Error('unknown'); })()),
    };
    return { child, db, registry, bindings, dispatch };
  })();
}

test('submit records the binding and the child id', async () => {
  const h = await harness();
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'fix tests' } });
    assert.equal(out.pending, false);
    assert.equal(out.reused, false);
    assert.match(out.binding.fleetRunId, /^fr_[0-9a-f]{32}$/);
    assert.equal(out.binding.childRunId, 'run_1');
    assert.ok(out.binding.boundAt, 'binding time recorded');
    assert.equal(h.bindings.state(out.binding.fleetRunId)!.status, 'QUEUED');
    assert.deepEqual(h.child.authSeen, ['Bearer child-secret-value']);
  } finally { await h.child.close(); h.db.close(); }
});

test('the same client token never produces a second child call', async () => {
  const h = await harness();
  try {
    const a = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' }, clientToken: 'tok-1' });
    const b = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' }, clientToken: 'tok-1' });
    assert.equal(b.reused, true);
    assert.equal(b.binding.fleetRunId, a.binding.fleetRunId);
    assert.equal(h.child.created.length, 1, 'the child must have been asked exactly once');
  } finally { await h.child.close(); h.db.close(); }
});

test('THE ORPHAN CASE: a lost response yields one child Run, not two', async () => {
  // The interleaving this whole design exists for. The child creates the Run and the reply never arrives,
  // so Fleet knows nothing. Recovery must re-ask with the same key and get the SAME Run back.
  const h = await harness({ dropResponse: true });
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'expensive task' } });
    assert.equal(out.pending, true, 'Fleet must report unknown, not failure');
    assert.equal(out.binding.childRunId, null);
    assert.equal(h.bindings.state(out.binding.fleetRunId)!.status, UNKNOWN);
    assert.equal(h.child.created.length, 1, 'the child really did create a Run');

    // "Restart": a fresh store over the same data, then recovery.
    const rec = await recoverPending(h.dispatch);
    assert.equal(rec.resolved, 1);
    assert.equal(h.child.created.length, 1, 'recovery must NOT create a second Run');
    const binding = h.bindings.get(out.binding.fleetRunId)!;
    assert.equal(binding.childRunId, 'run_1', 'recovery found the Run that was already running');
  } finally { await h.child.close(); h.db.close(); }
});

test('a rejected submission leaves no binding behind', async () => {
  const h = await harness({ failWith: 400 });
  try {
    await assert.rejects(
      () => submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: '' } }),
      (err: Error) => err instanceof DispatchError && /rejected the submission/.test(err.message),
    );
    assert.equal(h.bindings.pending().length, 0, 'a 4xx created nothing, so nothing may linger');
  } finally { await h.child.close(); h.db.close(); }
});

test('an unreachable child leaves the binding pending rather than failed', async () => {
  const h = await harness({ unreachable: true });
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
    assert.equal(out.pending, true);
    assert.equal(h.bindings.state(out.binding.fleetRunId)!.status, UNKNOWN);
    assert.notEqual(h.bindings.state(out.binding.fleetRunId)!.status, 'FAILED');
    assert.equal(h.bindings.pending().length, 1);
  } finally { await h.child.close(); h.db.close(); }
});

test('recovery leaves a still-unreachable binding pending instead of discarding it', async () => {
  const h = await harness({ unreachable: true });
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
    const rec = await recoverPending(h.dispatch);
    assert.equal(rec.resolved, 0);
    assert.equal(rec.stillPending, 1);
    assert.ok(h.bindings.get(out.binding.fleetRunId), 'deleting this binding is how a Run becomes an orphan');
  } finally { await h.child.close(); h.db.close(); }
});

test('refresh keeps the last known status when a child goes quiet', async () => {
  const h = await harness();
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
    h.child.setStatus('RUNNING');
    await refreshStates(h.dispatch, '*');
    assert.equal(h.bindings.state(out.binding.fleetRunId)!.status, 'RUNNING');
    // Stop the child entirely. The host row is left alone: removing it is now refused while it owns Runs,
    // and doing that was the very orphaning bug this test used to commit itself.
    await h.child.close();
    await refreshStates(h.dispatch, '*');
    const state = h.bindings.state(out.binding.fleetRunId)!;
    assert.equal(state.status, 'RUNNING', 'unreachable must not rewrite a known status to FAILED');
    assert.ok(state.lastError, 'but it must say the reading may be stale');
  } finally { h.db.close(); }
});

test('a disabled or unknown host is refused before anything is written', async () => {
  const h = await harness();
  try {
    await assert.rejects(() => submitRun(h.dispatch, { hostId: 'ghost', ownerId: 'alice', requested: {} }),
      (e: Error) => e instanceof DispatchError && e.status === 404);
    h.registry.setEnabled('studio', false);
    await assert.rejects(() => submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: {} }),
      (e: Error) => e instanceof DispatchError && e.status === 409);
    assert.equal(h.bindings.list('*').length, 0);
  } finally { await h.child.close(); h.db.close(); }
});

test('bindings are scoped by host for listing', async () => {
  const h = await harness();
  try {
    await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'a' } });
    h.registry.add({ id: 'other', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' });
    assert.equal(h.bindings.list('*').length, 1);
    assert.equal(h.bindings.list(['other']).length, 0);
    assert.equal(h.bindings.list(['studio']).length, 1);
    assert.equal(h.bindings.list([]).length, 0, 'an empty allowlist sees nothing, not everything');
  } finally { await h.child.close(); h.db.close(); }
});

test('removing a host that owns Runs is refused, not cascaded', async () => {
  // The schema used to declare ON DELETE CASCADE on fleet_runs.host_id, so an ordinary `hosts rm` deleted
  // the only record of Runs still executing. Section 5 calls orphaned Runs the worst failure this system
  // can produce, and it was reachable through a routine registry edit.
  const h = await harness();
  try {
    const out = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'long job' } });
    assert.throws(() => h.registry.remove('studio'),
      (err: Error) => /still owns 1 Fleet Run/.test(err.message) && /force to accept the loss/.test(err.message));
    assert.ok(h.bindings.get(out.binding.fleetRunId), 'the binding must survive the refused removal');

    // The escape hatch exists, but only when asked for by name.
    assert.equal(h.registry.remove('studio', { force: true }), true);
    assert.equal(h.bindings.list('*').length, 0);
  } finally { await h.child.close(); h.db.close(); }
});

test('a pending binding makes the refusal say the child answer is unknown', async () => {
  const h = await harness({ unreachable: true });
  try {
    await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
    assert.throws(() => h.registry.remove('studio'),
      /with no recorded child answer/);
  } finally { await h.child.close(); h.db.close(); }
});

test('the schema itself refuses deleting a host that owns Runs', async () => {
  // The registry guard is one line of defence; the foreign key is the other, and it is the one that still
  // holds if the guard is ever edited away. Tested with raw SQL so it exercises the constraint rather than
  // the guard that sits in front of it.
  const h = await harness();
  try {
    await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'still running' } });
    assert.throws(() => h.db.prepare("DELETE FROM hosts WHERE id = 'studio'").run(),
      /FOREIGN KEY|constraint/i,
      'fleet_runs.host_id must not cascade; deleting it must be refused at the schema level');
    assert.equal(h.bindings.list('*').length, 1, 'the binding must still be there');
  } finally { await h.child.close(); h.db.close(); }
});

test('an idempotency token is scoped to its owner, not global', async () => {
  // Tokens used to be unique across the whole table. Two callers reaching for the same memorable token
  // collided, and the second was handed the first one's run id, host and status.
  const h = await harness();
  try {
    const a = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'mine' }, clientToken: 'same' });
    const b = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'bob', requested: { task: 'theirs' }, clientToken: 'same' });
    assert.equal(b.reused, false, 'bob must not reuse alice binding');
    assert.notEqual(b.binding.fleetRunId, a.binding.fleetRunId);
    assert.equal(b.binding.ownerId, 'bob');
    assert.equal(h.bindings.findByClientToken('alice', 'same')!.fleetRunId, a.binding.fleetRunId);
    assert.equal(h.bindings.findByClientToken('carol', 'same'), null, 'a third caller sees neither');
  } finally { await h.child.close(); h.db.close(); }
});

test('reusing a token for a different host is refused, not silently redirected', async () => {
  // Handing back the studio binding when the caller just named gpu would suppress the dispatch they asked
  // for and report a Run running somewhere they never chose.
  const h = await harness();
  try {
    await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' }, clientToken: 'k' });
    h.registry.add({ id: 'gpu', baseUrl: h.child.url, credentialRef: 'lan-ref' });
    await assert.rejects(
      () => submitRun(h.dispatch, { hostId: 'gpu', ownerId: 'alice', requested: { task: 'x' }, clientToken: 'k' }),
      (err: Error) => err instanceof DispatchError && err.status === 409
        && /already used for host studio, not gpu/.test(err.message),
    );
    assert.equal(h.bindings.list('*').length, 1, 'the refused attempt must create nothing');
  } finally { await h.child.close(); h.db.close(); }
});

test('list carries cached state through the join, not a query per row', async () => {
  const h = await harness();
  try {
    const a = await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'a' } });
    await submitRun(h.dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'b' } });
    h.bindings.recordState({
      fleetRunId: a.binding.fleetRunId, status: 'RUNNING', cursor: 7,
      lastSeenAt: '2026-01-01T00:00:00.000Z', lastError: null,
    });

    const views = h.bindings.list('*');
    assert.equal(views.length, 2);
    const withState = views.find((v) => v.fleetRunId === a.binding.fleetRunId)!;
    assert.equal(withState.state?.status, 'RUNNING');
    assert.equal(withState.state?.cursor, 7);
    // Every submit writes a cache row, so the null case is a DELETED cache -- which is the whole point of
    // keeping run_state rebuildable. The LEFT JOIN must yield null rather than a half-populated object.
    h.db.prepare('DELETE FROM run_state').run();
    const afterDelete = h.bindings.list('*');
    assert.deepEqual(afterDelete.map((v) => v.state), [null, null],
      'a binding with no cache row must read as null state, not a zeroed one');

    // Counting statements is the only way to show the N+1 is gone rather than merely hidden.
    let queries = 0;
    const original = h.db.prepare.bind(h.db);
    (h.db as any).prepare = (sql: string) => { queries++; return original(sql); };
    h.bindings.list('*');
    assert.equal(queries, 1, 'listing must prepare exactly one statement');
    assert.equal(h.bindings.list([]).length, 0, 'an empty allowlist sees nothing, not everything');
  } finally { await h.child.close(); h.db.close(); }
});
