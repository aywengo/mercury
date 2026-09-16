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
  assert.match(read.reason, /not JSON/);
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
