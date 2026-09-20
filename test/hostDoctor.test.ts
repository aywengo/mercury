/**
 * `mercury host doctor` (docs/host-installer.md M4) — the verification command.
 *
 * The M4 doctor contract: healthz version check, one smoke Run per enabled harness.
 * Every check is bounded and a missing piece is reported, not crashed on. There is no
 * Fleet check: Fleet is pull, not push (issue #645) — the host never contacts Fleet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import {
  loadEnvFile,
  envFilePath,
  checkHealthz,
  smokeRun,
  bindHealthzTarget,
  lanAddresses,
  runHostDoctor,
  schemeFor,
} from '../src/host/doctor.ts';
import type { NetworkInterfaceInfo } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');

/** A tiny mock server: /healthz ok, /api/runs creates + completes. Binds 127.0.0.1
 *  explicitly (issue #185); the loopback-equivalent bind doctor tests need nothing else. */
function mockServer(): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const runs: Record<string, string> = {};
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.1.1' }));
        return;
      }
      if (url === '/api/runs' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { agent?: string };
          const id = `run-${Object.keys(runs).length + 1}`;
          runs[id] = 'QUEUED';
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ runId: id, status: 'QUEUED' }));
          // Complete it shortly.
          setTimeout(() => { runs[id] = 'COMPLETED'; }, 50);
        });
        return;
      }
      const m = url.match(/^\/api\/runs\/(run-\d+)$/);
      if (m && req.method === 'GET') {
        // Mirror the REAL API shape: { run: { status } } with UPPERCASE RunStatus.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run: { status: runs[m[1]!] ?? 'UNKNOWN' }, skills: [], goal: null, knowledge: [] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      res({
        server,
        url,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------- env file ----------

test('loadEnvFile: parses KEY=VALUE lines', () => {
  const dir = tempDir('doctor-env-');
  const p = join(dir, 'mercury.env');
  writeFileSync(p, 'MERCURY_PORT=4000\nMERCURY_HARNESSES=primeagent,hermes\n');
  const vars = loadEnvFile(p);
  assert.equal(vars.MERCURY_PORT, '4000');
  assert.equal(vars.MERCURY_HARNESSES, 'primeagent,hermes');
});

test('loadEnvFile: missing file returns empty', () => {
  assert.deepEqual(loadEnvFile('/nonexistent/env'), {});
});

// ---------- checks ----------

test('checkHealthz: ok when the host answers', async () => {
  const m = await mockServer();
  try {
    const r = await checkHealthz(m.url);
    assert.equal(r.ok, true);
    assert.ok(r.detail.includes('0.1.1'));
  } finally {
    await m.close();
  }
});

test('checkHealthz: fails cleanly when unreachable', async () => {
  const r = await checkHealthz('http://127.0.0.1:1', 1000);
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('unreachable'));
});

// ---------- smoke run ----------

test('smokeRun: creates a run and waits for completion', async () => {
  const m = await mockServer();
  try {
    const r = await smokeRun(m.url, 'tok', 'primeagent', 5000);
    assert.equal(r.ok, true);
    assert.ok(r.detail.includes('completed'));
  } finally {
    await m.close();
  }
});

test('smokeRun: sends the bounded smoke instruction (#648)', async () => {
  let seenTask = '';
  const runsBounded: Record<string, string> = {};
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/runs' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seenTask = (JSON.parse(body) as { task?: string }).task ?? '';
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-bounded', status: 'QUEUED' }));
        setTimeout(() => { runsBounded['run-bounded'] = 'COMPLETED'; }, 30);
      });
      return;
    }
    const m = url.match(/^\/api\/runs\/(.+)$/);
    if (m && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run: { status: runsBounded[m[1]!] ?? 'QUEUED' }, skills: [], goal: null, knowledge: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  try {
    const r = await smokeRun(`http://127.0.0.1:${addr.port}`, 'tok', 'primeagent', 5000);
    assert.equal(r.ok, true);
    assert.equal(seenTask, 'Reply with the single word DONE. Do not modify any files.');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('smokeRun: a FAILED run is a terminal failure, not a timeout', async () => {
  // A server whose run goes FAILED immediately.
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/runs' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runId: 'run-fail', status: 'QUEUED' }));
      return;
    }
    const m = url.match(/^\/api\/runs\/(.+)$/);
    if (m && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run: { status: 'FAILED' }, skills: [], goal: null, knowledge: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  try {
    const r = await smokeRun(`http://127.0.0.1:${addr.port}`, 'tok', 'primeagent', 5000);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('FAILED'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------- the all-skipped rule (#648) ----------

test('runHostDoctor: all smoke checks skipped is a failure, not a pass (#648)', async () => {
  const m = await mockServer();
  const dir = tempDir('doctor-allskipped-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}\nMERCURY_HARNESSES=primeagent\n`);
  try {
    const out: string[] = [];
    const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
    assert.equal(code, 1, 'all-skipped smoke must exit 1');
    assert.ok(out.join('').includes('every smoke check was skipped'), 'the human report must say why');
  } finally {
    await m.close();
  }
});

test('runHostDoctor: a token turns skips into real smoke Runs (#648)', async () => {
  const m = await mockServer();
  const dir = tempDir('doctor-token-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}\nMERCURY_HARNESSES=primeagent\nMERCURY_ADMIN_TOKEN=tok-doctor-1\n`);
  try {
    const code = await runHostDoctor([], { out: () => {}, err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
    assert.equal(code, 0, 'healthz ok + a completed smoke run => exit 0');
  } finally {
    await m.close();
  }
});

// ---------- the empty-harness-list gate (#654) ----------

test('schemeFor: https only when both TLS variables are set (#668 round 6)', () => {
  assert.equal(schemeFor({}), 'http');
  assert.equal(schemeFor({ MERCURY_TLS_CERT: '/c.pem' }), 'http');
  assert.equal(schemeFor({ MERCURY_TLS_KEY: '/k.pem' }), 'http');
  assert.equal(schemeFor({ MERCURY_TLS_CERT: '/c.pem', MERCURY_TLS_KEY: '/k.pem' }), 'https');
});

test('bindHealthzTarget: a routable bind address gets a healthz URL (issue #665)', () => {
  const t = bindHealthzTarget({ MERCURY_BIND_HOST: '192.168.1.10' }, '3000');
  assert.deepEqual(t, { address: '192.168.1.10', url: 'http://192.168.1.10:3000' });
  const tHttps = bindHealthzTarget({ MERCURY_BIND_HOST: 'mercury.example.com' }, '8443', 'https');
  assert.deepEqual(tHttps, { address: 'mercury.example.com', url: 'https://mercury.example.com:8443' });
});

test('bindHealthzTarget: loopback-equivalent binds are skipped (#668 rounds 1+7)', () => {
  for (const bind of ['127.0.0.1', 'loopback', 'localhost', '::1', 'Loopback', '  LOOPBACK  ']) {
    assert.equal(bindHealthzTarget({ MERCURY_BIND_HOST: bind }, '3000'), undefined, bind);
  }
  assert.equal(bindHealthzTarget({}, '3000'), undefined, 'unset');
});

const FAKE_LAN: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as NetworkInterfaceInfo],
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo,
    { address: '192.0.2.7', family: 'IPv4', internal: false } as NetworkInterfaceInfo,
  ],
  en1: [{ address: '10.1.2.3', family: 'IPv4', internal: false } as NetworkInterfaceInfo],
};

test('lanAddresses keeps non-internal IPv4 in interface order (#674)', () => {
  assert.deepEqual(lanAddresses(FAKE_LAN), ['192.0.2.7', '10.1.2.3']);
  assert.deepEqual(lanAddresses({}), []);
  // IPv6-only machine (beyond link-local): nothing to dial.
  assert.deepEqual(lanAddresses({ en0: [{ address: 'fd00::1', family: 'IPv6', internal: false } as NetworkInterfaceInfo] }), []);
});

test('bindHealthzTarget: 0.0.0.0 dials the first LAN IPv4 and reports it (#674)', () => {
  const t = bindHealthzTarget({ MERCURY_BIND_HOST: '0.0.0.0' }, '3000', 'http', FAKE_LAN);
  assert.deepEqual(t, { address: '0.0.0.0', dialed: '192.0.2.7', url: 'http://192.0.2.7:3000' });
  const tHttps = bindHealthzTarget({ MERCURY_BIND_HOST: '0.0.0.0' }, '8443', 'https', FAKE_LAN);
  assert.deepEqual(tHttps, { address: '0.0.0.0', dialed: '192.0.2.7', url: 'https://192.0.2.7:8443' });
});

test('bindHealthzTarget: 0.0.0.0 on a loopback-only host is an explicit SKIP (#674)', () => {
  const t = bindHealthzTarget({ MERCURY_BIND_HOST: '0.0.0.0' }, '3000', 'http', {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as NetworkInterfaceInfo],
  });
  assert.deepEqual(t, {
    address: '0.0.0.0',
    url: '',
    skip: 'no non-internal IPv4 address on this host to dial (loopback-only host?)',
  });
});

test('runHostDoctor: no bind check for loopback-equivalent MERCURY_BIND_HOST (#665, #668 round 7)', async () => {
  for (const bind of ['', '127.0.0.1', 'localhost', 'Loopback']) {
    const m = await mockServer();
    const dir = tempDir('doctor-bind-skip-');
    const cfg = join(dir, 'cfg');
    mkdirSync(join(cfg, 'mercury'), { recursive: true });
    writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}
MERCURY_HARNESSES=primeagent
MERCURY_ADMIN_TOKEN=tok-doctor-1
${bind ? `MERCURY_BIND_HOST=${bind}
` : ''}`);
    try {
      const out: string[] = [];
      const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
      assert.equal(code, 0, bind || '(unset)');
      assert.ok(!out.join('').includes('healthz (bind'), `${bind || '(unset)'}: no second check`);
    } finally {
      await m.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('runHostDoctor: 0.0.0.0 dials the resolved LAN address and reports it (#674)', async () => {
  // The injected "LAN" address is 127.0.0.1 marked non-internal — a test construct that
  // makes the dial deterministic against the loopback-bound mock (#185: explicit literal
  // host) without binding or probing a real LAN interface.
  const fakeLan: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    en9: [{ address: '127.0.0.1', family: 'IPv4', internal: false } as NetworkInterfaceInfo],
  };
  const m = await mockServer();
  const dir = tempDir('doctor-bind-lan-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}
MERCURY_HARNESSES=primeagent
MERCURY_ADMIN_TOKEN=tok-doctor-1
MERCURY_BIND_HOST=0.0.0.0
`);
  try {
    const out: string[] = [];
    const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv, { interfaces: fakeLan });
    assert.equal(code, 0);
    assert.ok(out.join('').includes(`healthz (bind 0.0.0.0, dialed 127.0.0.1): PASS — host`), out.join(''));
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHostDoctor: 0.0.0.0 with a dead LAN target FAILS, exit 1 (#674)', async () => {
  // TEST-NET-3 is unroutable: the dial must fail (bounded), and the report must name the
  // dialed address so the operator can tell firewall from bind problems.
  const fakeLan: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    en9: [{ address: '203.0.113.7', family: 'IPv4', internal: false } as NetworkInterfaceInfo],
  };
  const m = await mockServer();
  const dir = tempDir('doctor-bind-lan-fail-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}
MERCURY_HARNESSES=primeagent
MERCURY_ADMIN_TOKEN=tok-doctor-1
MERCURY_BIND_HOST=0.0.0.0
`);
  try {
    const out: string[] = [];
    const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv, { interfaces: fakeLan });
    assert.equal(code, 1);
    assert.ok(out.join('').match(/healthz \(bind 0\.0\.0\.0, dialed 203\.0\.113\.7\): FAIL — healthz unreachable/), out.join(''));
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHostDoctor: 0.0.0.0 on a loopback-only host prints an explicit SKIP (#674)', async () => {
  const m = await mockServer();
  const dir = tempDir('doctor-bind-lan-skip-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}
MERCURY_HARNESSES=primeagent
MERCURY_ADMIN_TOKEN=tok-doctor-1
MERCURY_BIND_HOST=0.0.0.0
`);
  try {
    const out: string[] = [];
    const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv, { interfaces: {} });
    assert.equal(code, 0);
    assert.ok(out.join('').includes('healthz (bind 0.0.0.0): SKIP — no non-internal IPv4 address on this host to dial'), out.join(''));
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});test('runHostDoctor: an empty MERCURY_HARNESSES is a failure, not a vacuous pass (#654)', async () => {
  const m = await mockServer();
  const dir = tempDir('doctor-emptyharness-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}\nMERCURY_HARNESSES=\n`);
  try {
    const out: string[] = [];
    const code = await runHostDoctor([], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
    assert.equal(code, 1, 'configured to verify nothing must exit 1');
    assert.ok(out.join('').includes('no harnesses configured'), 'the human report must say why');
    assert.ok(out.join('').includes('MERCURY_HARNESSES is set but empty'), 'the report names the variable and its state');
  } finally {
    await m.close();
  }
});

test('runHostDoctor: --allow-no-harnesses is the explicit escape for hosts that run none (#654)', async () => {
  const m = await mockServer();
  const dir = tempDir('doctor-allowempty-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), `MERCURY_PORT=${new URL(m.url).port}\nMERCURY_HARNESSES=\n`);
  try {
    const code = await runHostDoctor(['--allow-no-harnesses'], { out: () => {}, err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
    assert.equal(code, 0, 'the explicit escape exits 0 when healthz passes');
  } finally {
    await m.close();
  }
});

test('runHostDoctor: --json exposes noHarnesses for the empty list (#654)', async () => {
  const dir = tempDir('doctor-emptyjson-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_HARNESSES=\n');
  const out: string[] = [];
  await runHostDoctor(['--json'], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
  const parsed = JSON.parse(out.join('')) as { noHarnesses: boolean; smoke: unknown[] };
  assert.equal(parsed.noHarnesses, true, 'the JSON must expose the empty-configuration fact');
  assert.equal(parsed.smoke.length, 0, 'an explicit empty list is not filled with the defaults');
});

test('runHostDoctor: an unset MERCURY_HARNESSES still gets the default list (#654 is about an explicit empty)', async () => {
  const dir = tempDir('doctor-unsetjson-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_PORT=1\n');
  const out: string[] = [];
  await runHostDoctor(['--json'], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
  const parsed = JSON.parse(out.join('')) as { noHarnesses: boolean; smoke: Array<{ harness: string; skipped?: boolean }> };
  assert.equal(parsed.noHarnesses, false);
  assert.ok(parsed.smoke.length >= 3, 'unset keeps the documented default harness list');
});

test('runHostDoctor: a whitespace-only MERCURY_HARNESSES is also empty (#654)', async () => {
  const dir = tempDir('doctor-wsjson-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_HARNESSES= , ,\n');
  const out: string[] = [];
  await runHostDoctor(['--json'], { out: (s) => out.push(s), err: () => {} }, { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv);
  const parsed = JSON.parse(out.join('')) as { noHarnesses: boolean };
  assert.equal(parsed.noHarnesses, true, 'whitespace-only entries are not harnesses');
});

// ---------- the CLI surface ----------

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

test('host doctor --json reports both sections', async () => {
  const dir = tempDir('doctor-cli-');
  const { code, stdout } = await cli(['host', 'doctor', '--json'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1); // host not running -> healthz fails
  const parsed = JSON.parse(stdout) as { healthz: { ok: boolean }; allSmokeSkipped: boolean; smoke: Array<{ harness: string; skipped?: boolean }> };
  assert.equal(parsed.healthz.ok, false);
  assert.ok(!('fleet' in parsed), 'no Fleet section: the host never contacts Fleet (issue #645)');
  assert.equal(parsed.allSmokeSkipped, true, 'all-skipped is a failure the JSON must expose (#648)');
  assert.ok(parsed.smoke.length >= 3, 'one smoke entry per enabled harness');
  // No API token -> smoke skipped, not failed.
  assert.ok(parsed.smoke.every((s) => s.skipped === true));
});

test('host doctor rejects an unknown flag', async () => {
  const { code, stderr } = await cli(['host', 'doctor', '--bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('host doctor accepts --allow-no-harnesses (#654)', async () => {
  const dir = tempDir('doctor-allowflag-');
  const { code, stderr } = await cli(['host', 'doctor', '--allow-no-harnesses'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.notEqual(code, null);
  assert.ok(!stderr.includes('unknown flag'), '--allow-no-harnesses must parse, not error');
});

test('host doctor reads mercury.env for port and harnesses', async () => {
  const dir = tempDir('doctor-envfile-');
  const cfg = join(dir, 'cfg');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_HARNESSES=primeagent\n');
  const { code, stdout } = await cli(['host', 'doctor', '--json'], {
    XDG_CONFIG_HOME: cfg,
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout) as { smoke: Array<{ harness: string }> };
  assert.deepEqual(parsed.smoke.map((s) => s.harness), ['primeagent']);
});
