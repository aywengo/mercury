import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
