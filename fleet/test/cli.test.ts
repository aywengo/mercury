import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const CLI = resolve(import.meta.dirname, '..', 'cli.ts');
const SECRET = 'cli-secret-never-print';

function env(dir: string, creds: Record<string, string>, mode = 0o600) {
  const credFile = join(dir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify(creds), { mode });
  chmodSync(credFile, mode);
  return { ...process.env, FLEET_DB: join(dir, 'fleet.db'), FLEET_CREDENTIALS_FILE: credFile,
           FLEET_PROBE_TIMEOUT_MS: '1500', NO_COLOR: '1' };
}

/**
 * Run the CLI as a real subprocess.
 *
 * Deliberately asynchronous. The first version used spawnSync, which blocks this process's event loop for
 * the whole run -- and the fake Mercury these tests talk to is an in-process HTTP server, so it could not
 * answer while the CLI was asking. Every probe timed out at exactly the probe timeout, which looked like a
 * networking bug and was a test-harness deadlock.
 */
async function fleet(args: string[], e: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; stdout: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: e });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      clearTimeout(killer);
      // Node prints "ExperimentalWarning: SQLite/Type Stripping" on stderr for every run. Tests that parse
      // JSON read stdout alone; tests that assert on operator-visible messaging see both.
      resolvePromise({ code, out: stdout + stderr, stdout });
    });
  });
}

async function fakeMercury(body: unknown) {
  const server = createServer((req, res) => {
    const known = req.url === '/healthz' || req.url === '/healthz/workers' || req.url === '/api/agents';
    res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(known ? body : { error: 'nope' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('add then list renders a table, and --json is machine-readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  const fake = await fakeMercury({ workers: [{ workerId: 'w1', activeRuns: 2 }], queueDepth: 3, agents: ['prime-agent'], ok: true });
  try {
    let r = await fleet(['hosts', 'add', 'box-lan-2', '--url', fake.url, '--credential', 'lan-token',
                   '--label', 'gpu=true', '--path', '/Users/roman/mercury'], e);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /added box-lan-2/);

    r = await fleet(['hosts', 'list'], e);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ID\s+STATE\s+SEEN/);
    assert.match(r.out, /box-lan-2/);
    assert.match(r.out, /never-probed/);

    r = await fleet(['hosts', 'list', '--json'], e);
    const parsed = JSON.parse(r.stdout) as { hosts: Array<{ id: string; labels: Record<string, string>; localPaths: string[] }> };
    assert.equal(parsed.hosts[0]!.id, 'box-lan-2');
    assert.deepEqual(parsed.hosts[0]!.labels, { gpu: 'true' });
    assert.deepEqual(parsed.hosts[0]!.localPaths, ['/Users/roman/mercury']);
  } finally { await fake.close(); }
});

test('probe reports a live host as up and exits zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  const fake = await fakeMercury({ workers: [{ workerId: 'w1', activeRuns: 2 }], queueDepth: 3, agents: ['prime-agent'] });
  try {
    assert.equal((await fleet(['hosts', 'add', 'live', '--url', fake.url, '--credential', 'lan-token'], e)).code, 0);
    const r = await fleet(['hosts', 'probe', 'live'], e);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\bup\b/);
    assert.match(r.out, /\b3\b/, 'queue depth should be visible');
  } finally { await fake.close(); }
});

test('probe of a dead host exits non-zero so it composes in a readiness check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  await fleet(['hosts', 'add', 'ghost', '--url', 'http://127.0.0.1:1', '--credential', 'lan-token'], e);
  const r = await fleet(['hosts', 'probe', 'ghost'], e);
  assert.equal(r.code, 1);
  assert.match(r.out, /down/);
});

test('no command ever prints a credential value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET, 'other-ref': 'second-secret-xyz' });
  const fake = await fakeMercury({ workers: [], queueDepth: 0, agents: [] });
  try {
    await fleet(['hosts', 'add', 'h', '--url', fake.url, '--credential', 'lan-token'], e);
    const outputs: string[] = [];
    for (const args of [['credentials', 'list'], ['credentials', 'list', '--json'],
                        ['hosts', 'list'], ['hosts', 'list', '--json'],
                        ['hosts', 'probe'], ['hosts', 'probe', '--json']]) {
      outputs.push((await fleet(args, e)).out);
    }
    for (const out of outputs) {
      assert.ok(!out.includes(SECRET), `secret leaked into: ${out.slice(0, 120)}`);
      assert.ok(!out.includes('second-secret-xyz'), 'other secret leaked');
    }
    // And the names are still visible, so the operator can act.
    assert.match((await fleet(['credentials', 'list'], e)).out, /lan-token/);
  } finally { await fake.close(); }
});

test('add rejects a credential ref that does not resolve, naming the known refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'real-ref': SECRET });
  const r = await fleet(['hosts', 'add', 'h', '--url', 'http://127.0.0.1:3000', '--credential', 'typo-ref'], e);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown credential ref "typo-ref"/);
  assert.match(r.out, /known refs: real-ref/);
});

test('add refuses a URL that embeds a secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  const r = await fleet(['hosts', 'add', 'h', '--url', 'https://user:tok@host:3000', '--credential', 'lan-token'], e);
  assert.equal(r.code, 2);
  assert.match(r.out, /must not embed credentials/);
});

test('a world-readable credential file blocks every command that needs it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET }, 0o644);
  const r = await fleet(['hosts', 'list', '--live'], e);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /owner-only|chmod 600/);
});

test('enable, disable and rm round-trip through the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  await fleet(['hosts', 'add', 'h', '--url', 'http://127.0.0.1:3000', '--credential', 'lan-token'], e);
  assert.match((await fleet(['hosts', 'disable', 'h'], e)).out, /h disabled/);
  assert.match((await fleet(['hosts', 'list'], e)).out, /disabled/);
  assert.match((await fleet(['hosts', 'enable', 'h'], e)).out, /h enabled/);
  assert.match((await fleet(['hosts', 'rm', 'h'], e)).out, /removed h/);
  assert.equal((await fleet(['hosts', 'rm', 'h'], e)).code, 1, 'removing twice must not pretend to succeed');
});

test('bad input fails with usage rather than a stack trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'));
  const e = env(dir, { 'lan-token': SECRET });
  let r = await fleet(['hosts', 'add', 'h'], e);
  assert.equal(r.code, 2);
  assert.match(r.out, /usage: fleet hosts add/);
  r = await fleet(['nonsense'], e);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown command group/);
  r = await fleet(['hosts', 'add', 'h', '--url', 'http://a:1', '--credential', 'lan-token', '--label', 'noequals'], e);
  assert.equal(r.code, 2);
  assert.match(r.out, /expects key=value/);
});


// --- API schema refusal at registration (issue #510) ------------------------

/**
 * A minimal Mercury whose /healthz shape is chosen by the caller.
 *
 * In-process on purpose: the CLI runs as a subprocess, so an in-process server can answer while the
 * child asks. Doing this with spawnSync deadlocks every probe against the probe timeout.
 */
async function fakeHost(healthBody: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/healthz') res.end(JSON.stringify(healthBody));
    else if (req.url === '/healthz/workers') res.end(JSON.stringify({ workers: [], queueDepth: 0 }));
    else res.end(JSON.stringify({ agents: ['fake'] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('hosts add refuses a host below the minimum API schema, naming both numbers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-api-'));
  const e = env(dir, { 'lan-token': SECRET });
  const fake = await fakeHost({ ok: true, ts: new Date().toISOString(), product: 'host', version: '0.0.9', api: 0 });
  try {
    const r = await fleet(['hosts', 'add', 'old', '--url', fake.url, '--credential', 'lan-token'], e);
    assert.equal(r.code, 2, 'an incompatible host must not be added silently');
    // Both numbers, because the operator's decision is "upgrade the host or downgrade Fleet".
    assert.match(r.out, /api schema 0/i, 'must name the host schema');
    assert.match(r.out, /requires at least 1/i, 'must name the required schema');
    assert.match(r.out, /0\.0\.9/, 'must name the host version');
    // Refusing must not half-write. A registry entry that Fleet then probes as incompatible is worse
    // than a clean refusal, because it shows up as a permanently broken host.
    const list = await fleet(['hosts', 'list'], e);
    assert.doesNotMatch(list.out, /\bold\b/, 'a refused add must leave nothing in the registry');
  } finally { await fake.close(); }
});

test('hosts add still accepts a host that is merely down', async () => {
  // The counterpart to the refusal above. Only POSITIVE incompatibility blocks an add; a host that
  // is not listening yet is a normal thing to register, and refusing it would break the documented
  // workflow of adding a host before starting it.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-down-'));
  const e = env(dir, { 'lan-token': SECRET });
  const r = await fleet(['hosts', 'add', 'later', '--url', 'http://127.0.0.1:1', '--credential', 'lan-token'], e);
  assert.equal(r.code, 0, 'an unreachable host must still be addable');
  assert.match(r.out, /added later/);
  assert.match((await fleet(['hosts', 'list'], e)).out, /later/);
});

test('hosts list --live shows the host version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-live-'));
  const e = env(dir, { 'lan-token': SECRET });
  const fake = await fakeHost({ ok: true, ts: new Date().toISOString(), product: 'host', version: '0.1.1', api: 1 });
  try {
    const add = await fleet(['hosts', 'add', 'here', '--url', fake.url, '--credential', 'lan-token'], e);
    assert.equal(add.code, 0);
    assert.match(add.out, /0\.1\.1/, 'add should report the version it just saw');
    const live = await fleet(['hosts', 'list', '--live'], e);
    assert.equal(live.code, 0);
    assert.match(live.out, /HOST/, 'the table needs a column an operator can read');
    assert.match(live.out, /0\.1\.1/, 'hosts list --live must show the host version');
  } finally { await fake.close(); }
});


// --- fleet knowledge (Atlas project health, docs/knowledge-base.md §14) -------------------------

const GOOD_SUMMARY = {
  projectId: 'mercury',
  byTier: { candidate: 2, promoted: 3 },
  promotedByKind: { convention: 2, fact: 1 },
  contestedPairs: 1,
  contributors: [{ hostId: 'mac-studio', notes: 7, lastArrival: new Date().toISOString() }],
  latestSeq: 42,
};

async function fakeAtlas(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function withAtlas(dir: string, url: string) {
  return { ...env(dir, {}), FLEET_ATLAS_URL: url, FLEET_ATLAS_TOKEN: 'reader-token-0000000000000000',
           FLEET_ATLAS_PROJECT: 'mercury', FLEET_ATLAS_TIMEOUT_MS: '2000' };
}

test('fleet knowledge refuses clearly when Atlas is not configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const r = await fleet(['knowledge'], env(dir, {}));
  assert.equal(r.code, 2, 'a question this Fleet cannot answer is not a successful answer');
  // Names all three, because an operator who set one and forgot two needs to know which two.
  for (const v of ['FLEET_ATLAS_URL', 'FLEET_ATLAS_TOKEN', 'FLEET_ATLAS_PROJECT']) {
    assert.ok(r.out.includes(v), `the refusal must name ${v}: ${r.out}`);
  }
});

test('fleet knowledge rejects a subcommand it does not have', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const r = await fleet(['knowledge', 'promote'], withAtlas(dir, 'http://127.0.0.1:1'));
  assert.equal(r.code, 2);
  assert.match(r.out, /usage: fleet knowledge/);
});

test('fleet knowledge renders the four numbers §14 asks for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const a = await fakeAtlas((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(GOOD_SUMMARY)); });
  try {
    const r = await fleet(['knowledge'], withAtlas(dir, a.url));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /project\s+mercury/);
    assert.match(r.out, /candidates 2 awaiting promotion/, 'candidates awaiting promotion, named');
    assert.match(r.out, /kinds\s+convention 2 {2}fact 1/, 'promoted note count by kind');
    assert.match(r.out, /contested\s+1 pair/, 'contested pairs');
    assert.match(r.out, /mac-studio\s+7/, 'per-contributor note count');
    assert.ok(!/reader-token/.test(r.out), 'the reader token must never reach stdout');
  } finally { await a.close(); }
});

test('fleet knowledge --json emits the view unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const a = await fakeAtlas((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(GOOD_SUMMARY)); });
  try {
    const r = await fleet(['knowledge', '--json'], withAtlas(dir, a.url));
    assert.equal(r.code, 0, r.out);
    // stdout ALONE, per the convention documented on the helper above. This test originally parsed
    // `r.out`, which is stdout+stderr; Node 22 writes "ExperimentalWarning: SQLite / Type Stripping"
    // to stderr after the JSON, so the parse died at position 502 while Node 24 -- which emits no such
    // warning -- passed. A machine-readable surface has to be parseable from stdout by itself, or
    // `fleet knowledge --json | jq` breaks on exactly the runtimes that warn.
    const view = JSON.parse(r.stdout);
    assert.equal(view.state, 'ok');
    assert.equal(view.stale, false);
    assert.equal(view.summary.contestedPairs, 1);
  } finally { await a.close(); }
});

test('a malformed Atlas exits 1 and says malformed, not unreachable', async () => {
  // The exit code and the word both matter: an operator scripting on this needs to distinguish
  // "Atlas is down" from "Atlas is up and lying", and would otherwise restart a healthy service.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const a = await fakeAtlas((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"projectId":"mercury"}'); });
  try {
    const r = await fleet(['knowledge'], withAtlas(dir, a.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /malformed/);
    assert.ok(!/unreachable/.test(r.out), `must not blame the transport: ${r.out}`);
  } finally { await a.close(); }
});

test('a refused Atlas reports the status Atlas gave', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const a = await fakeAtlas((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'token may not read project mercury' })); });
  try {
    const r = await fleet(['knowledge'], withAtlas(dir, a.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /403/);
    assert.match(r.out, /may not read project/, "Atlas's own words are the diagnosis");
  } finally { await a.close(); }
});


test('an empty promotion queue still prints a zero, not a silence', async () => {
  // Atlas omits a tier with no notes rather than storing a zero, so a breakdown line is the wrong
  // place to read "nothing is waiting": the number vanishes precisely when the news is good, and an
  // operator cannot tell an empty queue from a rendering bug.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-atlas-'));
  const empty = { ...GOOD_SUMMARY, byTier: { promoted: 3 } };
  const a = await fakeAtlas((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(empty)); });
  try {
    const r = await fleet(['knowledge'], withAtlas(dir, a.url));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /candidates 0 awaiting promotion/, 'a zero must be printed, not omitted');
  } finally { await a.close(); }
});
