/**
 * `API_SCHEMA_VERSION` may move only on a breaking change to a shape Fleet reads (issue #518).
 *
 * PR #516 put a number on `/healthz` and made Fleet refuse any host reporting less than
 * `MIN_HOST_API`. The whole design rests on one rule, stated in `src/version.ts`: `api` moves ONLY
 * when a response shape inside Fleet's call allowlist (`fleet/child.ts`) changes in a way an older
 * Fleet would misread. Before this file, nothing checked it. Both ways of getting it wrong are
 * silent and they point in opposite directions:
 *
 *   bump `api` on a release that changed no shape -> Fleet refuses hosts it can serve perfectly.
 *     An availability outage caused by a version string.
 *   change a shape inside the allowlist and forget to bump -> the failure #510 exists to prevent:
 *     an old Fleet reads a new host and dies at first dispatch instead of at registration.
 *
 * So the number is tied to the shapes it claims to describe, in both directions, by
 * `test/fixtures/api-shapes.json`:
 *
 *   1. the live host must still answer the shapes recorded for `current` (direction two above);
 *   2. `current` must equal `API_SCHEMA_VERSION`, and each version's snapshot must differ from the
 *      one before it by a BREAKING change (direction one above).
 *
 * The asymmetry from the issue is preserved deliberately: a purely ADDITIVE change -- a new optional
 * field -- is not breaking, because an old Fleet ignores unknown keys. Endpoints are therefore
 * checked as a SUBSET of the live response, and only the three endpoints whose full key sets
 * `test/fleetContract.test.ts` has always pinned carry `exact` levels. A guard that demanded a bump
 * for additive changes would train people to bump reflexively, which is mistake one.
 *
 * The live half runs against the real router and the real SQLite queue (`realMercury`), because a
 * stub answers with whatever shape its author wrote -- the exact thing under test. It does NOT spawn
 * Fleet: the shapes are the host's side of the contract, and `fleetContract.test.ts` already pays
 * for a Fleet child to prove the reading half. Nothing here imports anything under `fleet/`; the two
 * Fleet files are read as TEXT, which is also what keeps `fleet/test/coupling.test.ts` satisfied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_SCHEMA_VERSION } from '../src/version.ts';
import { realMercury } from './realMercury.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'api-shapes.json');
const TOKEN = 'schema-guard-token-4d2a';

interface EndpointSpec {
  readBy: string;
  exact?: string[];
  fields?: Record<string, string>;
  text?: { status: number; contentTypePrefix: string };
}
interface Snapshot { endpoints: Record<string, EndpointSpec> }
interface Fixture { _readme?: string[]; current: number; versions: Record<string, Snapshot> }

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
const current = fixture.versions[String(fixture.current)];
assert.ok(current, `fixture has no versions["${fixture.current}"]`);

// ---------------------------------------------------------------- shape machinery

/** The runtime JSON type. `null` and `array` are their own types because the wire says so. */
function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `workers[].workerId` -> ['workers', '[]', 'workerId'] */
function segments(path: string): string[] {
  return path.replace(/\[\]/g, '.[]').split('.');
}

/**
 * Resolve a recorded path against a live body.
 *
 * Returns every value the path fans out to (`[]` multiplies), or null when the path does not exist.
 * A path that exists but holds `undefined` is reported as absent: JSON has no undefined, so a key
 * carrying it is a key that will not survive the wire.
 */
function resolve(body: unknown, path: string): unknown[] | null {
  let cur: unknown[] = [body];
  for (const seg of segments(path)) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (seg === '[]') {
        if (!Array.isArray(c)) return null;
        next.push(...c);
      } else if (c !== null && typeof c === 'object' && !Array.isArray(c) && seg in (c as object)) {
        const v = (c as Record<string, unknown>)[seg];
        if (v === undefined) return null;
        next.push(v);
      } else {
        return null;
      }
    }
    cur = next;
  }
  return cur;
}

/** The recorded keys that are direct children of an object level. `agents[]` is an element type, not a key. */
function childKeys(level: string, fields: Record<string, string>): string[] {
  const prefix = level === '' ? '' : `${level}.`;
  const out: string[] = [];
  for (const p of Object.keys(fields)) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    if (rest.includes('.') || rest.includes('[]')) continue;
    out.push(rest);
  }
  return out;
}

function normTypes(types: string): string {
  return types.split('|').map((t) => t.trim()).sort().join('|');
}

/**
 * Check one recorded endpoint spec against one live response.
 *
 * Each problem carries whether an older Fleet could actually misread it. That distinction is not
 * decoration: the guidance printed on failure is the opposite in the two cases, and printing "bump
 * API_SCHEMA_VERSION" for an additive field is precisely how a guard teaches mistake one.
 */
interface Problem { text: string; breaking: boolean }

function checkEndpoint(name: string, spec: EndpointSpec, body: unknown): Problem[] {
  const problems: Problem[] = [];
  const fields = spec.fields ?? {};

  for (const [path, types] of Object.entries(fields)) {
    const allowed = types.split('|').map((t) => t.trim());
    const values = resolve(body, path);
    if (values === null) {
      if (!allowed.includes('missing')) {
        problems.push({ text: `${name}: ${path} is absent, expected ${types}`, breaking: true });
      }
      continue;
    }
    if (values.length === 0 && path.includes('[]')) {
      // An empty array proves nothing about its elements; the caller asserts non-emptiness separately.
      continue;
    }
    for (const v of values) {
      const t = jsonType(v);
      if (!allowed.includes('json') && !allowed.includes(t)) {
        problems.push({ text: `${name}: ${path} is ${t} (${JSON.stringify(v)?.slice(0, 60)}), expected ${types}`,
                        breaking: true });
        break;
      }
    }
  }

  for (const level of spec.exact ?? []) {
    const containers = level === '' ? [body] : resolve(body, level);
    if (containers === null) {
      problems.push({ text: `${name}: exact level "${level}" is absent`, breaking: true });
      continue;
    }
    const expected = childKeys(level, fields).sort();
    containers.forEach((c, i) => {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        problems.push({ text: `${name}: exact level "${level}[${i}]" is not an object`, breaking: true });
        return;
      }
      const actual = Object.keys(c as object).sort();
      const missing = expected.filter((k) => !actual.includes(k));
      const extra = actual.filter((k) => !expected.includes(k));
      if (missing.length || extra.length) {
        problems.push({
          text: `${name}: level "${level || '(root)'}" keys are [${actual}] but [${expected}] is recorded`
            + `${missing.length ? `; missing ${missing.join(', ')}` : ''}`
            + `${extra.length ? `; new ${extra.join(', ')}` : ''}`,
          // A key the host only ADDED is invisible to an old Fleet. Anything else is a removal or a
          // rename, which is what an old Fleet trips over.
          breaking: missing.length > 0,
        });
      }
    });
  }
  return problems;
}

/**
 * The recorded differences between two snapshots that an OLDER Fleet could misread.
 *
 * Breaking: a recorded field Fleet reads disappears, or its recorded type set changes in either
 * direction, or a recorded endpoint leaves the fixture. NOT breaking: anything added. That asymmetry
 * is the point of the issue -- treating an addition as breaking trains maintainers to bump
 * reflexively, and a reflexive bump is what takes healthy hosts out of rotation.
 *
 * A type change counts in both directions on purpose. `number` -> `number|null` means the host has
 * started sending something an old Fleet never handled, and `api < MIN_HOST_API` is exactly the kind
 * of comparison that reads a wrong type as a right one.
 *
 * A key removed from a pinned (`exact`) level needs no separate branch: a pinned key is by
 * construction a recorded field, so removing it is a recorded-field removal and the loop below
 * reports it. A branch for it would be a check that can never be the one that fires.
 */
function breakingDiff(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = [];
  for (const [name, ep] of Object.entries(prev.endpoints)) {
    const n = next.endpoints[name];
    if (!n) { out.push(`${name}: recorded endpoint no longer covered`); continue; }
    for (const [path, types] of Object.entries(ep.fields ?? {})) {
      const nt = n.fields?.[path];
      if (nt === undefined) out.push(`${name}: ${path} no longer recorded`);
      else if (normTypes(nt) !== normTypes(types)) out.push(`${name}: ${path} ${types} -> ${nt}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- live capture

const TOKEN_HEADERS = { authorization: `Bearer ${TOKEN}` };

async function jsonAt(m: Awaited<ReturnType<typeof realMercury>>, path: string, init: RequestInit = {}) {
  const res = await fetch(m.url + path, { ...init, headers: { ...TOKEN_HEADERS, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', json: JSON.parse(text) as unknown };
}

/**
 * Drive a Run through every state the allowlist endpoints need, then read all of them.
 *
 * The states matter. `/healthz/workers` only has lease elements to describe once a worker holds one
 * (an empty array makes the element assertions vacuous -- the hole the first draft of the
 * fleetContract shape test had), `/input` requires NEEDS_INPUT, and `/retry` requires a terminal
 * parent. Each is reached through the real stores rather than by faking a response.
 */
interface Captured { status: number; contentType: string; body: unknown }

async function captureShapes(): Promise<Record<string, Captured>> {
  const m = await realMercury({ token: TOKEN });
  try {
    const captured: Record<string, { status: number; contentType: string; body: unknown }> = {};
    const put = (name: string, r: { status: number; contentType: string; json: unknown }) =>
      captured[name] = { status: r.status, contentType: r.contentType, body: r.json };

    put('GET /healthz', await jsonAt(m, '/healthz'));
    put('GET /healthz/workers', await jsonAt(m, '/healthz/workers'));

    const created = await jsonAt(m, '/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'shape guard', agent: 'fake' }),
    });
    put('POST /api/runs', created);
    const runId = (created.json as { runId: string }).runId;
    assert.ok(runId, `POST /api/runs did not create a Run: ${JSON.stringify(created.json)}`);

    // A real lease, the way a worker takes one: claim then STARTING. claim() alone leaves the Run
    // QUEUED, and activeLeases() deliberately excludes QUEUED, so workers[] would stay empty.
    const claimed = m.env.queue.claim('worker-shape', 60_000);
    assert.ok(claimed, 'claim() returned null: nothing was queued');
    m.env.runs.transition(claimed.id, 'STARTING');
    m.env.runs.transition(claimed.id, 'RUNNING');
    put('GET /healthz/workers', await jsonAt(m, '/healthz/workers'));
    put('GET /api/agents', await jsonAt(m, '/api/agents'));
    put('GET /api/runs/:runId', await jsonAt(m, `/api/runs/${runId}`));

    m.env.runs.transition(claimed.id, 'NEEDS_INPUT');
    put('POST /api/runs/:runId/input', await jsonAt(m, `/api/runs/${runId}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'go' }),
    }));
    put('GET /api/runs/:runId/events', await jsonAt(m, `/api/runs/${runId}/events?after=0&limit=1000`));

    m.env.runs.transition(claimed.id, 'RUNNING');
    put('POST /api/runs/:runId/cancel', await jsonAt(m, `/api/runs/${runId}/cancel`, { method: 'POST' }));
    // Cancelling an active Run is cooperative: it stays RUNNING until the worker settles it, and
    // retry refuses a non-terminal parent. Settle it the way a worker honouring the flag would.
    m.env.runs.transition(claimed.id, 'CANCELLED');
    put('POST /api/runs/:runId/retry', await jsonAt(m, `/api/runs/${runId}/retry`, { method: 'POST' }));

    const metrics = await fetch(m.url + '/metrics', { headers: TOKEN_HEADERS });
    captured['GET /metrics'] = { status: metrics.status, contentType: metrics.headers.get('content-type') ?? '',
                                 body: await metrics.text() };
    // Only the capture leaves. Handing back `m` would hand back a server the finally has already
    // closed, and a later reader would have no way to tell that from a live one.
    return captured;
  } finally {
    await m.close();
  }
}

// ---------------------------------------------------------------- tests

test('the live host answers every shape recorded for the current API version', async () => {
  const captured = await captureShapes();

  // Non-vacuity first: a fixture that stopped covering anything, or a capture that silently
  // produced nothing, would make every assertion below pass.
  const recorded = Object.keys(current!.endpoints);
  assert.ok(recorded.length >= 10, `fixture covers only ${recorded.length} endpoints; it has stopped covering the allowlist`);
  assert.deepEqual(recorded.slice().sort(), Object.keys(captured).sort(),
    'the fixture and the capture disagree about which endpoints exist');

  // The assertions inside the fixture are only meaningful if the data under each path is real.
  const workers = (captured['GET /healthz/workers']!.body as { workers: unknown[] }).workers;
  assert.equal(workers.length, 1, `the shape guard needs a live lease to describe, got ${workers.length} workers`);
  const events = (captured['GET /api/runs/:runId/events']!.body as { events: unknown[] }).events;
  assert.ok(events.length > 0, 'the shape guard needs real events to describe, got an empty page');
  const agents = (captured['GET /api/agents']!.body as { agents: unknown[] }).agents;
  assert.ok(agents.length > 0, 'the shape guard needs a non-empty agents array');

  const problems: Problem[] = [];
  for (const [name, spec] of Object.entries(current!.endpoints)) {
    const got = captured[name]!;
    if (spec.text) {
      // Text, not JSON: Fleet merges the exposition body verbatim, so the contract is the status and
      // the media type. Asking a metrics endpoint for JSON is the trap getMetrics already avoids.
      assert.equal(got.status, spec.text.status, `${name} answered ${got.status}`);
      assert.ok(got.contentType.startsWith(spec.text.contentTypePrefix),
        `${name} answered ${got.contentType}; Fleet reads the body as ${spec.text.contentTypePrefix}`);
      continue;
    }
    // 2xx, not 200: create and retry answer 201, and the shape contract is about the body.
    assert.ok(got.status >= 200 && got.status < 300,
      `${name} answered ${got.status}: ${JSON.stringify(got.body).slice(0, 200)}`);
    problems.push(...checkEndpoint(name, spec, got.body));
  }

  const breaking = problems.filter((p) => p.breaking);
  const additive = problems.filter((p) => !p.breaking);
  assert.deepEqual(problems.map((p) => p.text), [],
    `response shapes drifted from test/fixtures/api-shapes.json:\n${problems.map((p) => p.text).join('\n')}\n\n`
    + (breaking.length
      ? `A field Fleet reads was removed or retyped. That is a breaking change: bump API_SCHEMA_VERSION\n`
        + `in src/version.ts, add a versions entry for the new number recording the new shapes, and raise\n`
        + `MIN_HOST_API in fleet/probe.ts so an older Fleet refuses this host at registration.\n`
        + `If this release was not meant to change what Fleet reads, revert the shape instead.`
      : `Every difference above is a key the host only ADDED. An older Fleet ignores unknown keys, so\n`
        + `this does NOT need an API_SCHEMA_VERSION bump -- bumping here would make older Fleets refuse\n`
        + `hosts they can serve. Record the new keys in versions["${fixture.current}"] and stop there.\n`
        + `(These three endpoints pin their whole key set, so an addition still has to be recorded.)`));
});

test('API_SCHEMA_VERSION cannot move without a recorded breaking shape change', () => {
  const versions = Object.keys(fixture.versions).map(Number).sort((a, b) => a - b);

  assert.equal(fixture.current, API_SCHEMA_VERSION,
    `src/version.ts says API_SCHEMA_VERSION = ${API_SCHEMA_VERSION} but the newest recorded shape\n`
    + `snapshot in test/fixtures/api-shapes.json is for version ${fixture.current}.\n\n`
    + (API_SCHEMA_VERSION > fixture.current
      ? `A bump is only justified when a shape inside Fleet's allowlist changed in a way an older\n`
        + `Fleet would misread. If this release changed no such shape, set it back to ${fixture.current}:\n`
        + `bumping on a cosmetic release makes older Fleets refuse hosts they can serve perfectly.\n`
        + `If the shape really did change, add versions["${API_SCHEMA_VERSION}"] with the new shapes --\n`
        + `the guard will then require it to differ from versions["${fixture.current}"] by a breaking change.`
      : `The fixture records snapshots newer than the host reports. Move API_SCHEMA_VERSION up, or\n`
        + `remove the snapshots that do not correspond to a shipped shape.`));

  assert.deepEqual(versions, Array.from({ length: fixture.current }, (_, i) => i + 1),
    `fixture versions must be 1..${fixture.current} with no gaps; found ${versions.join(', ')}`);

  for (let v = 2; v <= fixture.current; v += 1) {
    const prev = fixture.versions[String(v - 1)];
    const next = fixture.versions[String(v)];
    assert.ok(prev && next, `missing snapshot for version ${v}`);
    assert.notDeepEqual(breakingDiff(prev, next), [],
      `API_SCHEMA_VERSION was bumped to ${v}, but versions["${v}"] differs from versions["${v - 1}"]\n`
      + `only additively (or not at all). An older Fleet ignores keys it has never heard of, so this\n`
      + `release does not need to break older Fleets: put API_SCHEMA_VERSION back to ${v - 1}.`);
  }
});

test('the breaking-change rule distinguishes breaking from additive', () => {
  // The version-chain assertion above is vacuous while there is only one version, so the rule it
  // uses is tested directly. Without these cases, breakingDiff could be `() => []` and the guard
  // would still be green -- which is mistake one wearing a guard's clothes.
  const base: Snapshot = { endpoints: { 'GET /healthz': { readBy: 'x', exact: [''],
    fields: { ok: 'boolean', api: 'number' } } } };
  const withFields = (fields: Record<string, string>): Snapshot =>
    ({ endpoints: { 'GET /healthz': { readBy: 'x', exact: [''], fields } } });

  assert.deepEqual(breakingDiff(base, base), [], 'an identical snapshot must not read as breaking');
  assert.deepEqual(breakingDiff(base, withFields({ ok: 'boolean', api: 'number', ts: 'string' })), [],
    'an added key is additive: an older Fleet ignores it, so it must NOT justify a bump');
  assert.deepEqual(
    breakingDiff(base, { endpoints: { ...base.endpoints, 'GET /metrics': { readBy: 'x', fields: {} } } }), [],
    'Fleet learning to read a new endpoint is a Fleet change, not a change to what the host sends');

  assert.ok(breakingDiff(base, withFields({ ok: 'boolean' })).length > 0,
    'a dropped field Fleet reads is THE breaking case; the rule must catch it');
  assert.ok(breakingDiff(base, withFields({ ok: 'string', api: 'number' })).length > 0,
    'a retyped field is breaking; `api < MIN_HOST_API` depends on it staying a number');
  assert.ok(breakingDiff(base, withFields({ ok: 'boolean', api: 'number|null' })).length > 0,
    'widening is breaking too: the host now sends a value an older Fleet never had to handle');
  assert.ok(breakingDiff(base, { endpoints: {} }).length > 0,
    'an endpoint Fleet reads must not silently leave the fixture');
  assert.ok(breakingDiff(base, withFields({ ok: 'boolean' })).some((d) => d.includes('api')),
    'the difference must name the field, or the operator cannot act on it');

  // The rule must be able to see a real rename, end to end, through the same code the live test uses.
  const live = { ok: true, ts: '2026-01-01T00:00:00.000Z', product: 'host', version: '0.1.1', api: 1 };
  assert.deepEqual(checkEndpoint('GET /healthz', current!.endpoints['GET /healthz']!, live).map((p) => p.text), [],
    'the checker rejects the real /healthz shape');
  const renamed = { ok: true, ts: '2026-01-01T00:00:00.000Z', product: 'host', version: '0.1.1', apiVersion: 1 };
  const found = checkEndpoint('GET /healthz', current!.endpoints['GET /healthz']!, renamed);
  assert.ok(found.some((p) => p.breaking && p.text.includes('api')), 'a renamed api field must be reported as breaking');
  assert.ok(found.some((p) => p.text.includes('new apiVersion')), 'the new key must be named so the fix is obvious');

  // The additive half of the asymmetry, at a pinned endpoint: a key the host only added must be
  // reported WITHOUT the bump guidance, because following bump guidance here is mistake one.
  const widened = { ...live, build: 'abc123' };
  const added = checkEndpoint('GET /healthz', current!.endpoints['GET /healthz']!, widened);
  assert.equal(added.length, 1, `an added key must produce exactly one problem, got ${JSON.stringify(added)}`);
  assert.equal(added[0]!.breaking, false, 'an added key is additive; calling it breaking trains reflexive bumps');
});

test('every endpoint in the Fleet allowlist is covered by the fixture', () => {
  // The fixture is only a guard if it covers the whole allowlist. This reads fleet/child.ts as TEXT
  // -- importing it would break fleet/test/coupling.test.ts -- so the allowlist stays honest as it
  // grows: add an endpoint without recording its shape and this fails.
  //
  // Known limit, stated rather than glossed: the scan matches the template-literal form
  // `${host.baseUrl}/path` that every call in fleet/child.ts uses today. A URL built another way --
  // string concatenation, `new URL(path, base)` -- would be invisible to it, and the floor below
  // catches a wholesale miss but not a partial one. If the call pattern ever changes, this scan has
  // to change with it; the floor is what makes that a loud failure rather than a quiet one.
  const src = readFileSync(join(import.meta.dirname, '..', 'fleet', 'child.ts'), 'utf8');
  const urls = [...src.matchAll(/\$\{host\.baseUrl\}([^`]*)`[\s\S]{0,400}?\bmethod:\s*'([A-Z]+)'/g)];
  const allowlist = urls.map((m) => {
    const path = m[1]!.split('?')[0]!.replace(/\$\{[^}]*\}/g, ':runId');
    return `${m[2]} ${path}`;
  });
  assert.ok(allowlist.length >= 7,
    `the allowlist scan found ${allowlist.length} endpoints; fleet/child.ts changed shape and this guard is blind`);

  const missing = allowlist.filter((e) => !current!.endpoints[e]);
  assert.deepEqual(missing, [],
    `Fleet calls these but no shape is recorded for them: ${missing.join(', ')}.\n`
    + `Record the fields Fleet reads under versions["${fixture.current}"].endpoints in\n`
    + `test/fixtures/api-shapes.json, or the next incompatible change ships unnoticed.`);
});

test('Fleet never requires a shape newer than the host reports', () => {
  // The availability half of the same rule. MIN_HOST_API above API_SCHEMA_VERSION means every Fleet
  // build refuses every host this one can serve -- the outage mode of mistake one, arriving from the
  // Fleet side instead of the bump side. Read as text for the same coupling reason as above.
  const src = readFileSync(join(import.meta.dirname, '..', 'fleet', 'probe.ts'), 'utf8');
  const m = /export const MIN_HOST_API\s*=\s*(\d+)/.exec(src);
  assert.ok(m, 'MIN_HOST_API is no longer a numeric literal in fleet/probe.ts; this guard cannot read it');
  const min = Number(m[1]);
  assert.ok(min <= API_SCHEMA_VERSION,
    `fleet/probe.ts requires MIN_HOST_API = ${min} but this host reports api = ${API_SCHEMA_VERSION}.\n`
    + `Every Fleet of this build would refuse every host of this build at \`hosts add\`.`);
});
