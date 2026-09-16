/**
 * The HTTP surface (docs/knowledge-base.md sections 11.1 and 11.4).
 *
 * Started as a real listener on an ephemeral port rather than by calling route handlers directly.
 * The properties worth proving are the ones that only exist at the socket: that auth is applied by the
 * dispatcher rather than remembered in each handler, that a body is parsed or refused before a handler
 * sees it, and that the status codes are the ones a host will branch on. Calling handlers in process
 * would let a forgotten `requireAdmin` pass every test here.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../db.ts';
import { loadAtlasConfig } from '../config.ts';
import { createRedactor } from '../redact.ts';
import { createLogger } from '../logger.ts';
import { AuthIndex, seedContributors } from '../auth.ts';
import { AtlasMetrics } from '../metrics.ts';
import { NoteStore } from '../notes.ts';
import { startAtlas, type AtlasServer } from '../server.ts';
import { ATLAS_VERSION } from '../version.ts';

const ADMIN = 'server-test-admin-token-0001';
const CONTRIBUTOR = 'server-test-contributor-token-01';
const READER = 'server-test-reader-token-00001';
const CONTRIBUTOR_B = 'server-test-contributor-token-b-01';
const READER_B = 'server-test-reader-token-b-00002';
const IDENTITY = 'github.com/aywengo/mercury';

let dir: string;
let server: AtlasServer;
let closeAll: () => Promise<void>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-server-'));
  const contributorsFile = join(dir, 'contributors.json');
  writeFileSync(contributorsFile, JSON.stringify({
    [CONTRIBUTOR]: { hostId: 'host-a', projects: ['mercury'] },
    // A second host bound to the summary fixture's project. Contributor tokens are project-scoped, so
    // without this the only way to write there would be the admin token -- and admin contributions carry
    // no hostId, which is exactly the field the summary's per-contributor section is about.
    [CONTRIBUTOR_B]: { hostId: 'host-b', projects: ['summary-proj'] },
  }), { mode: 0o600 });

  const config = loadAtlasConfig({
    ATLAS_DB: join(dir, 'atlas.db'),
    ATLAS_BIND_HOST: '127.0.0.1',
    ATLAS_PORT: '0',
    ATLAS_ADMIN_TOKEN: ADMIN,
    ATLAS_CONTRIBUTORS_FILE: contributorsFile,
    ATLAS_READER_TOKENS: `${READER}:dashboard:mercury,${READER_B}:summary-dashboard:summary-proj`,
    ATLAS_LOG_LEVEL: 'error',
  });
  const db = openDatabase(config.dbPath);
  // Seeding is a startup step the CLI performs, not something startAtlas does, so the fixture has to
  // do it too. A contributor file that never lands is otherwise indistinguishable from a typo in it.
  assert.deepEqual(seedContributors(db, contributorsFile), [CONTRIBUTOR, CONTRIBUTOR_B], 'the seeded tokens must be reported');
  const redactor = createRedactor(config.secrets);
  const store = new NoteStore(db, { maxClaimBytes: config.maxClaimBytes, maxDetailBytes: config.maxDetailBytes, maxEvidence: 8 }, redactor);
  const auth = new AuthIndex(db, config);
  server = await startAtlas({ db, config, store, auth, log: createLogger(redactor, 'error'), metrics: new AtlasMetrics() });
  closeAll = async () => { await server.close(); db.close(); };

  const created = await call('POST', '/v1/projects', ADMIN, {
    id: 'mercury', name: 'Mercury', repoIdentities: [IDENTITY],
    promotionPolicy: { auto: null },
  });
  assert.equal(created.status, 201, 'the fixture project must exist for the tests below');
});

after(async () => {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(server.url + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is itself a finding for the caller */ }
  return { status: res.status, json: json as any, text, headers: res.headers };
}

function contribution(claim: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'fact', scope: 'project', claim, evidence: [],
    provenance: { source: 'agent-reported', hostId: 'host-a', runId: 'run-1', agent: 'primeagent', harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
    repoIdentity: IDENTITY,
    ...extra,
  };
}

test('/healthz needs no token and answers with the shape Fleet probes', async () => {
  const res = await call('GET', '/healthz', null);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'product', 'ts', 'version']);
  assert.equal(res.json.product, 'atlas');
  assert.equal(res.json.version, ATLAS_VERSION);
});

test('a contributor contributes and a reader reads; neither can do the other', async () => {
  const write = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR,
    { notes: [contribution('the reader token must not be able to write')] }, { 'idempotency-key': 'srv-1' });
  assert.equal(write.status, 200);
  assert.ok('accepted' in write.json.results[0]!);

  const readerWrite = await call('POST', '/v1/projects/mercury/notes', READER,
    { notes: [contribution('a dashboard token must not write knowledge')] }, { 'idempotency-key': 'srv-2' });
  assert.equal(readerWrite.status, 403, 'a reader is read-only');

  const readerRead = await call('GET', '/v1/projects/mercury/notes?since=0&tier=all', READER);
  assert.equal(readerRead.status, 200);
  assert.ok(readerRead.json.notes.length >= 1);

  const anonRead = await call('GET', '/v1/projects/mercury/notes?since=0&tier=all', null);
  assert.equal(anonRead.status, 401, 'the feed is not public');
});

test('an unbound project answers 404, not 403', async () => {
  // Existence is the information. A 403 tells a caller the project exists but they may not see it,
  // which is exactly what an unbound contributor should not learn.
  const res = await call('GET', '/v1/projects/not-mine/notes?since=0', CONTRIBUTOR);
  assert.equal(res.status, 404);
  const write = await call('POST', '/v1/projects/not-mine/notes', CONTRIBUTOR, { notes: [] }, { 'idempotency-key': 'srv-3' });
  assert.equal(write.status, 404);
});

test('an unknown token is 401 and a missing header is 401, not 400', async () => {
  assert.equal((await call('GET', '/v1/projects', 'totally-unknown-token-0001')).status, 401);
  assert.equal((await call('GET', '/v1/projects', null)).status, 401);
});

test('a contribution without an idempotency key is refused', async () => {
  // Without a key a lost response cannot be retried safely, and the host would have to guess whether
  // its notes landed. Refusing is louder than accepting and double-counting.
  const res = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR, { notes: [contribution('no key here')] });
  assert.equal(res.status, 400);
});

test('a malformed body is a 400, not a crashed connection', async () => {
  const res = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR, '{"notes": [', { 'idempotency-key': 'srv-4' });
  assert.equal(res.status, 400);
});

test('curation is admin-only and requires a reason', async () => {
  const made = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR,
    { notes: [contribution('a note that needs an operator to promote it')] }, { 'idempotency-key': 'srv-5' });
  const noteId = made.json.results[0]!.accepted!;

  const byContributor = await call('POST', `/v1/projects/mercury/notes/${noteId}/promote`, CONTRIBUTOR, { reason: 'self-serving' });
  assert.equal(byContributor.status, 403, 'a host must not promote its own notes');

  const noReason = await call('POST', `/v1/projects/mercury/notes/${noteId}/promote`, ADMIN, {});
  assert.equal(noReason.status, 400, 'a promotion without a reason is an unaudited edit');

  const ok = await call('POST', `/v1/projects/mercury/notes/${noteId}/promote`, ADMIN, { reason: 'reviewed with the team' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.note.tier, 'promoted');
});

test('the project registry rejects an id that is not a slug and a missing repo set', async () => {
  const badId = await call('POST', '/v1/projects', ADMIN, { id: 'Not A Slug', name: 'x', repoIdentities: [IDENTITY] });
  assert.equal(badId.status, 400);
  const noRepos = await call('POST', '/v1/projects', ADMIN, { id: 'no-repos', name: 'x' });
  assert.equal(noRepos.status, 400, 'a project with no identities accepts nothing, so say so at creation');
});

test('a contributor token is never echoed back and must be long enough', async () => {
  const short = await call('POST', '/v1/contributors', ADMIN, { token: 'short', hostId: 'host-b', projects: ['mercury'] });
  assert.equal(short.status, 400);

  const secret = 'a-long-enough-contributor-token-9';
  const ok = await call('POST', '/v1/contributors', ADMIN, { token: secret, hostId: 'host-b', projects: ['mercury'] });
  assert.equal(ok.status, 201);
  assert.ok(!ok.text.includes(secret), 'the response must not carry the token it just stored');

  const list = await call('GET', '/v1/contributors', ADMIN);
  assert.ok(!list.text.includes(secret), 'the listing must not leak stored tokens');
});

test('/metrics is Prometheus text and labels rejections by reason', async () => {
  await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR,
    { notes: [contribution('this one carries hunter2secret inline')] }, { 'idempotency-key': 'srv-6' });

  const res = await call('GET', '/metrics', ADMIN);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(res.text, /^atlas_notes\{/m);
  assert.match(res.text, /atlas_rejections_total\{reason="secret-detected"\}/m,
    'an operator needs to tell "the host sends junk" from "the bounds are too tight"');
});

test('an unknown route is 404 and an unsupported method is 405 or 404, never 500', async () => {
  assert.equal((await call('GET', '/v1/nonsense', ADMIN)).status, 404);
  const wrongMethod = await call('DELETE', '/healthz', null);
  assert.ok(wrongMethod.status === 404 || wrongMethod.status === 405, `got ${wrongMethod.status}`);
});

test('a malformed percent-escape is answered with 400, not left hanging', async () => {
  // Route matching decodes path segments, and it runs BEFORE authentication. When the decoder threw,
  // the throw escaped the handler's try/catch, no response was ever written, and the connection hung
  // until the client timed out -- an unauthenticated caller could hold every socket on the listener
  // open with one bad character. So the assertion is not only about the status code: a response must
  // arrive at all.
  for (const path of ['/v1/projects/%E0%A4%A/notes', '/v1/projects/x/notes/%zz', '/v1/projects/%/notes']) {
    const res = await fetch(server.url + path, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 400, `${path} must be a client error`);
    await res.text();
  }
  // The listener still serves the next request normally: the bad input must not take anything down.
  assert.equal((await call('GET', '/healthz', null)).status, 200);
});

test('a request target that cannot be parsed is answered, not dropped', async () => {
  // `new URL(req.url, base)` throws on some targets Node will hand over. Written raw on the socket so
  // fetch cannot normalise the bad target before it gets here.
  const net = await import('node:net');
  const reply = await new Promise<string>((done, fail) => {
    const target = '/v1/projects/%%%/notes HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ' + CONTRIBUTOR + '\r\n\r\n';
    const port = Number(new URL(server.url).port);
    const sock = net.connect(port, '127.0.0.1', () => { sock.write('GET ' + target); });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); fail(new Error('no response to an unparseable request target')); }, 5_000);
    sock.on('data', (c) => {
      buf += c.toString();
      // Answer as soon as the status line is back. The server keeps the connection open, so waiting for
      // 'end' would wait for a close that a healthy keep-alive connection deliberately does not send.
      if (buf.includes('\r\n')) { clearTimeout(timer); done(buf); }
    });
    sock.on('end', () => { clearTimeout(timer); done(buf); });
    sock.on('error', (e) => { clearTimeout(timer); fail(e); });
  });
  assert.match(reply, /^HTTP\/1\.1 (400|404)/, 'the service must answer a bad request target');
});

test('an admin posting an operator note keeps the host the body names', async () => {
  // An operator note has to say which host recorded it, or it is not attributable. But an admin token is
  // not bound to any host, and the first version substituted the literal 'admin' for the caller's binding
  // and then ran the anti-spoofing check against it -- so EVERY operator note was rejected as
  // host-mismatch, and the feature was dead on arrival while every unit test stayed green.
  const made = await call('POST', '/v1/projects/mercury/notes', ADMIN, {
    notes: [{
      kind: 'convention', scope: 'project', claim: 'an operator wrote this down on host-c',
      evidence: [],
      provenance: { source: 'operator', hostId: 'host-c', recordedAt: new Date().toISOString() },
    }],
  }, { 'idempotency-key': 'srv-op-1' });
  assert.equal(made.status, 200);
  const noteId = made.json.results[0]!.accepted;
  assert.ok(noteId, `operator note rejected: ${JSON.stringify(made.json.results[0])}`);

  const detail = await call('GET', `/v1/projects/mercury/notes/${noteId}`, ADMIN);
  assert.equal(detail.json.note.provenance.hostId, 'host-c', 'the attribution the operator gave is kept');
  assert.equal(detail.json.note.tier, 'promoted', 'operator notes land promoted');

  // The contributor rule is unchanged: a host may still not speak for another host.
  const spoof = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR, {
    notes: [{
      kind: 'fact', scope: 'project', claim: 'a host claiming to be someone else',
      evidence: [],
      provenance: { source: 'agent-reported', hostId: 'host-victim', runId: 'r9', agent: 'primeagent', harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
    }],
  }, { 'idempotency-key': 'srv-op-2' });
  assert.deepEqual(spoof.json.results, [{ rejected: 'host-mismatch' }],
    'the admin exception must not become a way for any caller to name any host');
});

test('promoting a retired note whose claim is live is a 409 that names the blocker', async () => {
  // The dedup gate excludes retired rows, so a re-contributed claim lands as a second note. Promotion
  // never consults claim_hash, so without the transition guard this request would quietly put two live
  // notes on one claim and the next contribution would pick between them arbitrarily.
  const claim = 'retried requests use jittered exponential backoff';
  const first = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR,
    { notes: [contribution(claim)] }, { 'idempotency-key': 'srv-conf-1' });
  const firstId = first.json.results[0]!.accepted!;
  assert.equal((await call('POST', `/v1/projects/mercury/notes/${firstId}/retire`, ADMIN,
    { reason: 'uncorroborated at the time' })).status, 200);

  const again = await call('POST', '/v1/projects/mercury/notes', CONTRIBUTOR,
    { notes: [contribution(claim)] }, { 'idempotency-key': 'srv-conf-2' });
  const secondId = again.json.results[0]!.accepted!;
  assert.ok(secondId && secondId !== firstId, 'the re-contributed claim must land as a fresh note');

  const clash = await call('POST', `/v1/projects/mercury/notes/${firstId}/promote`, ADMIN,
    { reason: 'reinstate the original' });
  assert.equal(clash.status, 409, 'a promotion that would create two live notes is a conflict, not a fault');
  assert.equal(clash.json.code, 'claim-conflict');
  assert.equal(clash.json.details.conflictingNoteId, secondId,
    'the response has to name the note to retire, or the operator cannot act on it');

  // Retiring the live one first is the documented way out, and must work.
  assert.equal((await call('POST', `/v1/projects/mercury/notes/${secondId}/retire`, ADMIN,
    { reason: 'the original was correct after all' })).status, 200);
  const reinstated = await call('POST', `/v1/projects/mercury/notes/${firstId}/promote`, ADMIN,
    { reason: 'reinstate the original' });
  assert.equal(reinstated.status, 200, `reinstatement after clearing the claim should work: ${reinstated.text}`);
  assert.equal(reinstated.json.note.tier, 'promoted');
});

// --- project summary (section 14, the Fleet dashboard's data source) ---------------------------

/**
 * A contribution the summary fixture's project will actually accept.
 *
 * Written out rather than derived from `contribution()` with a spread, because that helper returns
 * `Record<string, unknown>` and its `provenance` is therefore `unknown` -- spreading it typechecks as
 * an error and runs fine, which is the worst combination. Three fields have to differ from the shared
 * helper at once: the host must match the token, the repo identity must belong to this project, and the
 * per-note `repoIdentity` is the one `contributeOne()` checks rather than the one on the request body.
 */
function summaryContribution(claim: string): Record<string, unknown> {
  return {
    kind: 'fact', scope: 'project', claim, evidence: [],
    provenance: {
      source: 'agent-reported', hostId: 'host-b', runId: 'run-1', agent: 'primeagent',
      harnessVersion: '1.0.0', recordedAt: new Date().toISOString(),
    },
    repoIdentity: 'github.com/example/summary',
  };
}

test('summary: a reader gets counts and not one claim', async () => {
  // Its own project, because the fixture above is shared and every other test writes into it. Exact
  // counts are only assertable against a project nobody else touches.
  const created = await call('POST', '/v1/projects', ADMIN, {
    id: 'summary-proj', name: 'Summary', repoIdentities: ['github.com/example/summary'],
    promotionPolicy: { auto: null },
  });
  assert.equal(created.status, 201, created.text);

  const promoted = await call('POST', '/v1/projects/summary-proj/notes', CONTRIBUTOR_B,
    { notes: [summaryContribution('npm run test:atlas runs only the atlas suite')] },
    { 'idempotency-key': 'sum-1' });
  assert.equal(promoted.status, 200, promoted.text);
  const noteId = promoted.json.results[0].accepted;
  const promotedRes = await call('POST', `/v1/projects/summary-proj/notes/${noteId}/promote`, ADMIN,
    { actor: 'admin', reason: 'operator note' });
  assert.equal(promotedRes.status, 200, promotedRes.text);

  await call('POST', '/v1/projects/summary-proj/notes', CONTRIBUTOR_B,
    { notes: [summaryContribution('a candidate that nobody has promoted yet')] },
    { 'idempotency-key': 'sum-2' });

  const res = await call('GET', '/v1/projects/summary-proj/summary', READER_B);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.byTier.promoted, 1, 'one promoted note was created');
  assert.equal(res.json.byTier.candidate, 1, 'one note is awaiting promotion');
  assert.deepEqual(res.json.promotedByKind, { fact: 1 }, 'promotedByKind covers promoted notes only');
  assert.equal(res.json.contestedPairs, 0);
  assert.ok(res.json.latestSeq > 0, 'the summary must expose the cursor a replica would be at');

  // The load-bearing assertion. A dashboard reader that could pull claims would be a second copy of the
  // knowledge base with a weaker token than the one section 12 hands out.
  assert.ok(!res.text.includes('test:atlas'), `the summary leaked claim text: ${res.text}`);
  assert.ok(!res.text.includes('nobody has promoted'), `the summary leaked claim text: ${res.text}`);

  const contributors = res.json.contributors as { hostId: string; notes: number; lastArrival: string }[];
  assert.deepEqual(contributors.map((c) => c.hostId), ['host-b']);
  assert.equal(contributors[0]!.notes, 2, 'both contributions came from this host');
  assert.ok(Date.parse(contributors[0]!.lastArrival) > 0, 'lastArrival must be a timestamp');
});

test('summary: a reader bound to another project cannot read it', async () => {
  // The reader token in this fixture is scoped to `mercury`. Owner-scoping is a rule AGENTS.md states for
  // the Run API and the same rule applies here: a dashboard token must not enumerate every project.
  const res = await call('GET', '/v1/projects/summary-proj/summary', READER);
  // 404 rather than 403, which is the rule AGENTS.md states for the Run API and which this route
  // inherits from requireProject: a token bound to one project must not be able to confirm that another
  // one exists. Asserted explicitly rather than accepted silently, because 403 here would be a real
  // information leak and a future "clarification" to 403 would reintroduce it quietly.
  assert.equal(res.status, 404, `expected 404 for a project the reader is not bound to, got ${res.status}`);
});

test('summary: no token at all is refused', async () => {
  const res = await call('GET', '/v1/projects/summary-proj/summary', null);
  assert.equal(res.status, 401, res.text);
});
