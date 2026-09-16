import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readProjectSummary, type AtlasReaderOptions } from '../atlas.ts';
import { assertAtlasConfigurable, loadConfig } from '../config.ts';
import type { FleetConfig } from '../config.ts';

const SUMMARY = {
  projectId: 'mercury',
  byTier: { promoted: 12, candidate: 3 },
  promotedByKind: { command: 4, convention: 8 },
  contestedPairs: 2,
  contributors: [{ hostId: 'host-a', notes: 7, lastArrival: '2026-09-16T00:00:00.000Z' }],
  latestSeq: 42,
};

function opts(over: Partial<AtlasReaderOptions> = {}): AtlasReaderOptions {
  return {
    baseUrl: 'http://127.0.0.1:4599',
    token: 'reader-token-0000000001',
    project: 'mercury',
    timeoutMs: 1_000,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Adapt a plain function to `typeof fetch`.
 *
 * Node's type stripper rejects `async (...) => ... as typeof fetch` in argument position, and the cast is
 * unavoidable because the real signature is an overload set no object literal satisfies. Doing it once
 * keeps every fake below readable.
 */
function asFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

const okAtlas = asFetch(async () => json(200, SUMMARY));

test('a successful read returns the summary and carries the reader token', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const read = await readProjectSummary(opts({
    fetchImpl: asFetch(async (url, init) => {
      seen.push({ url: String(url), init });
      return json(200, SUMMARY);
    }),
  }));

  assert.equal(read.kind, 'ok');
  if (read.kind !== 'ok') return;
  assert.deepEqual(read.value, SUMMARY);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:4599/v1/projects/mercury/summary');
  const headers = seen[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer reader-token-0000000001');
});

test('a project id is escaped into the path, not concatenated raw', async () => {
  const seen: string[] = [];
  await readProjectSummary(opts({
    project: 'a/../b',
    fetchImpl: asFetch(async (url) => {
      seen.push(String(url));
      return json(200, SUMMARY);
    }),
  }));
  assert.ok(!seen[0]!.includes('/a/../b/'), `path traversal reached the URL: ${seen[0]}`);
});

test('a 401 is "rejected", not "unreachable": a typo is not an outage', async () => {
  // The distinction an operator acts on. Atlas is answering fine; the token is wrong. Reporting this as
  // unreachable sends someone to check a service that is up, and keeps retrying a mistake that only a
  // config change can fix.
  const read = await readProjectSummary(opts({ fetchImpl: asFetch(async () => json(401, { error: 'unauthorized' })) }));
  assert.equal(read.kind, 'rejected');
  if (read.kind !== 'rejected') return;
  assert.equal(read.status, 401);
  assert.equal(read.detail, 'unauthorized');
});

test('a 404 on a project the reader is not bound to is "rejected" too', async () => {
  // Atlas answers 404 rather than 403 for an unbound project, deliberately, so a reader cannot enumerate
  // projects. It is still Atlas answering, so it must not read as an outage.
  const read = await readProjectSummary(opts({ fetchImpl: asFetch(async () => json(404, { error: 'no such project: x' })) }));
  assert.equal(read.kind, 'rejected');
  if (read.kind !== 'rejected') return;
  assert.equal(read.status, 404);
});

test('a 500 is "unreachable": Atlas is having a problem, not Fleet', async () => {
  const read = await readProjectSummary(opts({ fetchImpl: asFetch(async () => json(500, { error: 'internal' })) }));
  assert.equal(read.kind, 'unreachable');
});

test('a transport failure is "unreachable" and keeps the cause', async () => {
  // Node wraps ECONNREFUSED in a cause; without it the operator sees "fetch failed" and nothing else.
  const read = await readProjectSummary(opts({
    fetchImpl: asFetch(async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }),
  }));
  assert.equal(read.kind, 'unreachable');
  if (read.kind !== 'unreachable') return;
  assert.match(read.reason, /ECONNREFUSED/);
});

test('a 200 whose body is not JSON is reported, not thrown', async () => {
  // A proxy returning an HTML page with a 200 is the realistic version of this, and a throw would take
  // Fleet's own endpoint down over someone else's misconfiguration.
  const read = await readProjectSummary(opts({
    fetchImpl: asFetch(async () => new Response('<html>moved</html>', { status: 200 })),
  }));
  assert.equal(read.kind, 'unreachable');
  if (read.kind !== 'unreachable') return;
  assert.match(read.reason, /unreadable/);
});

test('408 and 429 are "unreachable": a 4xx that means "not right now" is not a refusal', async () => {
  // The 4xx rule is "Atlas answered and said no", but these two mean "I got it and could not answer".
  // Classifying them as rejected tells an operator to go change a configuration that is fine, and stops
  // a retry that would have worked.
  for (const status of [408, 429]) {
    const read = await readProjectSummary(opts({ fetchImpl: asFetch(async () => json(status, { error: 'slow down' })) }));
    assert.equal(read.kind, 'unreachable', `HTTP ${status} must not be reported as a config problem`);
  }
});

test('the read passes a timeout signal, so a hung Atlas cannot hold Fleet open', async () => {
  let sawSignal: AbortSignal | undefined;
  await readProjectSummary(opts({
    timeoutMs: 5,
    fetchImpl: asFetch(async (_url, init) => {
      sawSignal = init?.signal ?? undefined;
      return json(200, SUMMARY);
    }),
  }));
  assert.ok(sawSignal, 'the Atlas read must pass an AbortSignal');
});

// --- configuration ---------------------------------------------------------------------------

function atlasConfig(over: Partial<FleetConfig>): FleetConfig {
  return {
    atlasUrl: null, atlasToken: null, atlasProject: null, atlasTimeoutMs: 3_000,
    bindHost: '127.0.0.1', port: 3100, tlsCert: null, tlsKey: null,
    ...over,
  } as FleetConfig;
}

test('all three Atlas settings unset is fine and means "off"', () => {
  assert.doesNotThrow(() => assertAtlasConfigurable(atlasConfig({})));
});

test('a partial Atlas configuration is refused, naming what is missing', () => {
  // A URL with no token produces a dashboard that says "unreachable" forever, because the 401 reason does
  // not survive into Fleet's response. Failing at startup with the missing names is actionable; serving a
  // permanently empty section is not.
  assert.throws(
    () => assertAtlasConfigurable(atlasConfig({ atlasUrl: 'http://127.0.0.1:4599' })),
    /FLEET_ATLAS_TOKEN and FLEET_ATLAS_PROJECT/,
  );
});

test('FLEET_ATLAS_URL over plaintext http off loopback is refused', () => {
  // A reader token reads the whole project's counts. Plain HTTP to a remote host puts it on the wire.
  assert.throws(
    () => assertAtlasConfigurable(atlasConfig({
      atlasUrl: 'http://atlas.internal:4599', atlasToken: 't', atlasProject: 'p',
    })),
    /plaintext http/,
  );
});

test('loopback http and remote https are both accepted', () => {
  assert.doesNotThrow(() => assertAtlasConfigurable(atlasConfig({
    atlasUrl: 'http://127.0.0.1:4599', atlasToken: 't', atlasProject: 'p',
  })));
  assert.doesNotThrow(() => assertAtlasConfigurable(atlasConfig({
    atlasUrl: 'https://atlas.internal', atlasToken: 't', atlasProject: 'p',
  })));
});

test('loadConfig strips a trailing slash so the URL never doubles one', () => {
  const config = loadConfig({
    FLEET_ATLAS_URL: 'https://atlas.internal/',
    FLEET_ATLAS_TOKEN: 't',
    FLEET_ATLAS_PROJECT: 'p',
  });
  assert.equal(config.atlasUrl, 'https://atlas.internal');
});


// --- the cached reader: what the dashboard actually sees ----------------------------------------

import { createAtlasReader, parseSummary, ATLAS_SUMMARY_KEYS, type AtlasView } from '../atlas.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function reader(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: { cacheMs?: number; now?: () => number } = {}) {
  const c = clock();
  return {
    reader: createAtlasReader({
      baseUrl: 'http://127.0.0.1:4599', token: 't', project: 'mercury', timeoutMs: 1_000,
      fetchImpl: asFetch(fetchImpl), cacheMs: over.cacheMs ?? 15_000, now: over.now ?? c.now,
    }),
    clock: c,
  };
}

/**
 * Narrow the view union.
 *
 * `AtlasView` starts with a `{ configured: false }` arm, so every property below it has to be reached
 * through the discriminant or `tsc` refuses the access. Asserting once here reads better than an
 * `if (!view.configured) return` before each assertion, which would silently skip the assertions if
 * the arm ever changed.
 */
function assertConfigured(view: AtlasView): asserts view is Extract<AtlasView, { configured: true }> {
  if (!view.configured) throw new Error(`expected a configured Atlas view, got ${JSON.stringify(view)}`);
}

test('a healthy read is reported as ok and not stale', async () => {
  const { reader: r } = reader(async () => json(200, SUMMARY));
  const view = await r.view();
  assert.equal(view.configured, true);
  assertConfigured(view);
  assert.equal(view.state, 'ok');
  assert.equal(view.stale, false);
  if (view.state !== 'ok') return;
  assert.deepEqual(view.summary, SUMMARY);
});

test('a failure after a success keeps the last good numbers and says so', async () => {
  // Section 14 wants a stale replica to be visible, not fatal. A blank panel during an Atlas restart
  // tells an operator nothing; the last known numbers tell them the shape of the project -- but only
  // if labelled, because an unlabelled old number reads as current.
  let healthy = true;
  const { reader: r, clock: c } = reader(async () => (healthy ? json(200, SUMMARY) : json(500, { error: 'boom' })));
  const clockAdvance = () => c.advance(16_000);
  const first = await r.view();
  assertConfigured(first);
  assert.equal(first.state, 'ok');

  // Past the cache window, so this read actually reaches Atlas. Inside the window the floor above
  // correctly answers from cache and never notices the service has started failing -- which is the
  // right trade for a dashboard, and the reason the staleness assertion needs the clock moved.
  healthy = false;
  clockAdvance();
  const second = await r.view();
  assertConfigured(second);
  assert.equal(second.stale, true, 'a served-after-failure summary must be labelled stale');
  if (!second.stale) return;
  assert.deepEqual(second.summary, SUMMARY, 'the last good numbers survive');
  assert.equal(second.state, 'unreachable');
  assert.ok(second.reason.includes('500'));
});

test('a failure with nothing cached reports the failure, not an empty summary', async () => {
  const { reader: r } = reader(async () => json(401, { error: 'unauthorized' }));
  const view = await r.view();
  assert.equal(view.configured, true);
  assert.equal(view.state, 'rejected');
  assert.equal('summary' in view, false, 'no summary was ever fetched; the view must not invent one');
});

test('the cache floor stops a dashboard poll from hammering Atlas', async () => {
  // Without a floor, every open dashboard tab becomes a load generator pointed at a shared service.
  let calls = 0;
  const { reader: r, clock: c } = reader(async () => { calls++; return json(200, SUMMARY); });
  await r.view();
  await r.view();
  await r.view();
  assert.equal(calls, 1, 'three reads inside the cache window must be one request');
  c.advance(16_000);
  await r.view();
  assert.equal(calls, 2, 'past the window the next read goes through');
});


// --- parseSummary: a 200 that is not a project summary ------------------------------------------

test('the real summary shape passes', () => {
  const r = parseSummary(SUMMARY);
  assert.equal(r.ok, true);
});

test('a body that is not an object is rejected', () => {
  for (const bad of [null, undefined, [], 'ok', 7, true]) {
    const r = parseSummary(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not parse as a summary`);
  }
});

test('a missing field is rejected rather than read as a zero', () => {
  // This is the whole point. A dashboard that reads `undefined` renders an empty panel, which looks
  // exactly like a project that genuinely has no knowledge. A count we never received must not be
  // able to impersonate a count of zero.
  for (const key of ATLAS_SUMMARY_KEYS) {
    const partial: Record<string, unknown> = { ...SUMMARY };
    delete partial[key];
    const r = parseSummary(partial);
    assert.equal(r.ok, false, `missing ${key} must be rejected`);
    if (r.ok) continue;
    assert.ok(r.reason.includes(key), `the reason must name the missing field, got: ${r.reason}`);
  }
});

test('a field of the wrong shape is rejected', () => {
  const cases: [string, unknown][] = [
    ['byTier', 'promoted'],
    ['byTier', { promoted: 'many' }],
    ['byTier', null],
    ['promotedByKind', []],
    ['contestedPairs', '0'],
    ['contestedPairs', NaN],
    ['latestSeq', null],
    ['contributors', null],
    ['contributors', [{ hostId: 'h', notes: 1 }]],
    ['contributors', [{ hostId: 42, notes: 1, lastArrival: 'ts' }]],
    ['contributors', [null]],
  ];
  for (const [key, value] of cases) {
    const r = parseSummary({ ...SUMMARY, [key]: value });
    assert.equal(r.ok, false, `${key} = ${JSON.stringify(value)} must be rejected`);
  }
});

test('an extra field Atlas grows later does not break the read', () => {
  // Rejecting unknown keys would make every Atlas addition a breaking change for a deployed Fleet.
  const r = parseSummary({ ...SUMMARY, medianClaimAgeMs: 1234 });
  assert.equal(r.ok, true);
});

test('a malformed 200 is reported as malformed, not as a transport failure', async () => {
  // The distinction decides what the operator does next. "unreachable" means check the network;
  // this means Atlas is up and its answer is garbage.
  const { reader: r } = reader(async () => json(200, { projectId: 'mercury' }));
  const view = await r.view();
  assertConfigured(view);
  assert.equal(view.state, 'malformed');
  assert.equal('summary' in view, false);
  if (view.state !== 'malformed') return;
  assert.ok(view.reason.includes('byTier'), `the reason should name what was wrong: ${view.reason}`);
});

test('a malformed 200 after a good read keeps serving the last good numbers', async () => {
  let healthy = true;
  const { reader: r, clock: c } = reader(async () => (healthy ? json(200, SUMMARY) : json(200, {})));
  const first = await r.view();
  assertConfigured(first);
  assert.equal(first.state, 'ok');
  healthy = false;
  c.advance(16_000);
  const view = await r.view();
  assertConfigured(view);
  assert.equal(view.stale, true);
  assert.equal(view.state, 'malformed');
});
