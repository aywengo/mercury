// `host doctor`'s bots section (docs/dispatcher-bot-design.md §13; B4, #915).
//
// Acceptance: the doctor reports a bots line for a configured alias and fails cleanly (exit, named
// reason) for each seeded defect — token-copy mismatch, malformed config, unwritable state file.
// Every check is bounded and fail-closed, and no bot token is ever printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { checkBots, discoverBotAliases, stateFileWritable } from '../src/host/bots/doctor.ts';
import { runHostDoctor } from '../src/host/doctor.ts';
import type { SchedulerClient, BotRunView } from '../src/host/bots/scheduler.ts';

const OK_CFG = {
  description: 'maintenance',
  schedule: {
    tasks: [
      {
        name: 'maintenance',
        cron: '0 3 * * *',
        tz: 'UTC',
        template: { task: 'Daily maintenance' },
        singleFlight: true,
        onMiss: 'skip',
      },
    ],
  },
};

function fakeClient(runs: BotRunView[] = []): SchedulerClient {
  return {
    listOwnRuns: async () => ({ runs, nextCursor: null }),
    createRun: async () => { throw new Error('the doctor must never write'); },
  };
}

interface Home {
  dir: string;
  env: NodeJS.ProcessEnv;
  envPath: string;
  apiTokens: string;
}

function botHome(opts: {
  config?: unknown;
  credentials?: Record<string, unknown> | null;
  apiTokens?: string;
  envMode?: number;
  alias?: string;
} = {}): Home {
  const dir = tempDir('botdoctor-');
  const alias = opts.alias ?? 'maint';
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  if (opts.config !== undefined) {
    writeFileSync(join(dir, 'mercury', 'bots', `${alias}.json`), JSON.stringify(opts.config));
  }
  if (opts.credentials !== null) {
    const p = join(dir, 'mercury', 'bot-credentials.json');
    writeFileSync(p, JSON.stringify(opts.credentials ?? { [alias]: { api: 'tok-bot-maint-1' } }), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  const apiTokens = opts.apiTokens ?? 'tok-bot-maint-1:bot-maint';
  const envPath = join(dir, 'mercury', 'mercury.env');
  writeFileSync(envPath, `MERCURY_HARNESSES=\nMERCURY_API_TOKENS=${apiTokens}\n`, { mode: opts.envMode ?? 0o600 });
  chmodSync(envPath, opts.envMode ?? 0o600);
  return { dir, env: { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, 'state') }, envPath, apiTokens };
}

function check(home: Home, extra: Partial<Parameters<typeof checkBots>[0]> = {}) {
  return checkBots({
    env: home.env,
    vars: { MERCURY_API_TOKENS: home.apiTokens, MERCURY_HARNESSES: '' },
    envFilePath: home.envPath,
    nowMs: Date.parse('2026-10-24T00:00:00Z'),
    clientFor: () => fakeClient(),
    ...extra,
  });
}

// ---------- discovery and the state-file probe ----------

test('discoverBotAliases: only <alias>.json files, sorted, dotfiles ignored', () => {
  const home = botHome({ config: OK_CFG });
  writeFileSync(join(home.dir, 'mercury', 'bots', 'nightly.json'), '{}');
  writeFileSync(join(home.dir, 'mercury', 'bots', '.hidden.json'), '{}');
  writeFileSync(join(home.dir, 'mercury', 'bots', 'notes.md'), 'x');
  assert.deepEqual(discoverBotAliases(home.env), ['maint', 'nightly']);
});

test('discoverBotAliases: no bots directory means no bots, not an error', () => {
  const dir = tempDir('botdoctor-none-');
  assert.deepEqual(discoverBotAliases({ XDG_CONFIG_HOME: dir }), []);
});

test('stateFileWritable: an existing writable file passes, a read-only one fails', () => {
  const dir = tempDir('botdoctor-state-');
  const p = join(dir, 'maint.state.json');
  writeFileSync(p, '{"lastTickMs":1}\n', { mode: 0o600 });
  assert.equal(stateFileWritable(p).ok, true);
  chmodSync(p, 0o400);
  const ro = stateFileWritable(p);
  assert.equal(ro.ok, false);
  assert.match(ro.detail, /not writable/);
});

test('stateFileWritable: a fresh bot has no state file; the nearest existing directory decides', () => {
  const dir = tempDir('botdoctor-fresh-');
  assert.equal(stateFileWritable(join(dir, 'state', 'mercury', 'bots', 'maint.state.json')).ok, true);
  chmodSync(dir, 0o500);
  try {
    const ro = stateFileWritable(join(dir, 'state', 'mercury', 'bots', 'maint.state.json'));
    assert.equal(ro.ok, false);
  } finally {
    chmodSync(dir, 0o700);
  }
});

// ---------- the section ----------

test('no configured bots: no section at all', async () => {
  const dir = tempDir('botdoctor-empty-');
  const res = await checkBots({ env: { XDG_CONFIG_HOME: dir }, vars: {}, envFilePath: join(dir, 'none.env') });
  assert.deepEqual(res, { ok: true, bots: [] });
});

test('a healthy bot: config, token copies, state and the status view all pass', async () => {
  const home = botHome({ config: OK_CFG });
  const res = await check(home, {
    clientFor: () => fakeClient([{ id: 'run-7', status: 'COMPLETED', constraints: { botTask: 'maintenance' }, createdAt: '2026-10-23T23:00:00Z' }]),
  });
  assert.equal(res.ok, true);
  const line = res.bots[0]!;
  assert.equal(line.alias, 'maint');
  assert.equal(line.ok, true);
  assert.match(line.detail, /config ok, token ok, 1 task/);
  assert.match(line.detail, /next maintenance in 3h00m/);
  assert.match(line.detail, /last action run-7 task=maintenance COMPLETED, dispatches last hour: 1/);
  assert.equal(res.envFileMode?.ok, true);
});

test('seeded defect: a malformed config is a named FAIL, never a crash', async () => {
  const home = botHome({ config: { schedule: { tasks: [{ name: 'x', cron: 'nope', template: { task: 't' } }] } } });
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.equal(res.bots[0]!.ok, false);
  assert.match(res.bots[0]!.detail, /^config invalid: .*cron/);
});

test('seeded defect: a token copy that is not registered fails with the expected owner', async () => {
  const home = botHome({ config: OK_CFG, apiTokens: 'tok-alice:alice' });
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.match(res.bots[0]!.detail, /is not registered in MERCURY_API_TOKENS \(expected owner 'bot-maint'\)/);
  assert.ok(!res.bots[0]!.detail.includes('tok-bot-maint-1'), 'the token value must not appear');
});

test('seeded defect: a token registered under another owner fails, naming both owners', async () => {
  const home = botHome({ config: OK_CFG, apiTokens: 'tok-bot-maint-1:alice' });
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.match(res.bots[0]!.detail, /registered as owner 'alice', expected 'bot-maint'/);
});

test('seeded defect: an unreadable credentials file is a named FAIL', async () => {
  const home = botHome({ config: OK_CFG, credentials: null });
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.match(res.bots[0]!.detail, /^credentials: /);
});

test('seeded defect: an unwritable state file is a named FAIL', async () => {
  const home = botHome({ config: OK_CFG });
  const stateDir = join(home.dir, 'state', 'mercury', 'bots');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'maint.state.json');
  writeFileSync(statePath, '{"lastTickMs":1}\n', { mode: 0o400 });
  chmodSync(statePath, 0o400);
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.match(res.bots[0]!.detail, /^state: .*not writable/);
});

test('a rejected bot token is the design\'s 401 line, not a generic outage', async () => {
  const home = botHome({ config: OK_CFG });
  const res = await check(home, {
    clientFor: () => ({
      listOwnRuns: async () => { throw new Error('GET /api/runs answered 401'); },
      createRun: async () => { throw new Error('not used'); },
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.bots[0]!.detail, 'token rejected (401); check bot-credentials.json');
});

test('an unreachable API is a fail-closed status line', async () => {
  const home = botHome({ config: OK_CFG });
  const res = await check(home, {
    clientFor: () => ({
      listOwnRuns: async () => { throw new Error('fetch failed'); },
      createRun: async () => { throw new Error('not used'); },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.bots[0]!.detail, /^status unavailable: fetch failed/);
});

test('a group-readable mercury.env fails the section (§4.2: it holds tokens)', async () => {
  const home = botHome({ config: OK_CFG, envMode: 0o644 });
  const res = await check(home);
  assert.equal(res.ok, false);
  assert.equal(res.envFileMode?.ok, false);
  assert.match(res.envFileMode!.detail, /mode 644/);
  assert.equal(res.bots[0]!.ok, true, 'the bot itself is fine; the file mode is its own line');
});

// ---------- runHostDoctor integration ----------

function doctorServer(token: string): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((req, res2) => {
      const url = req.url ?? '';
      if (url === '/healthz') {
        res2.writeHead(200, { 'Content-Type': 'application/json' });
        res2.end(JSON.stringify({ ok: true, version: '0.2.5' }));
        return;
      }
      if (url.startsWith('/api/runs') && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res2.writeHead(401, { 'Content-Type': 'application/json' });
          res2.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res2.writeHead(200, { 'Content-Type': 'application/json' });
        res2.end(JSON.stringify({ runs: [], nextCursor: null }));
        return;
      }
      res2.writeHead(404, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      res({ server, url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function doctorHome(url: string, apiTokens: string, credentialToken: string): NodeJS.ProcessEnv {
  const dir = tempDir('botdoctor-host-');
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bots', 'maint.json'), JSON.stringify({
    ...OK_CFG,
    api: { url, timeoutMs: 5_000 },
  }));
  const creds = join(dir, 'mercury', 'bot-credentials.json');
  writeFileSync(creds, JSON.stringify({ maint: { api: credentialToken } }), { mode: 0o600 });
  chmodSync(creds, 0o600);
  const envPath = join(dir, 'mercury', 'mercury.env');
  writeFileSync(envPath, [
    `MERCURY_PORT=${new URL(url).port}`,
    'MERCURY_HARNESSES=',
    'MERCURY_ADMIN_TOKEN=tok-admin-doctor',
    `MERCURY_API_TOKENS=${apiTokens}`,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, 'state') } as NodeJS.ProcessEnv;
}

test('runHostDoctor prints a bots line and exits 0 for a healthy bot', async () => {
  const m = await doctorServer('tok-bot-maint-1');
  try {
    const env = doctorHome(m.url, 'tok-bot-maint-1:bot-maint', 'tok-bot-maint-1');
    const out: string[] = [];
    const code = await runHostDoctor(['--allow-no-harnesses'], { out: (s) => out.push(s), err: () => {} }, env);
    const text = out.join('');
    assert.match(text, /bot maint: PASS — config ok, token ok, 1 task/);
    assert.match(text, /bots: PASS — .*mode 600/);
    assert.equal(code, 0, text);
  } finally {
    await m.close();
  }
});

test('runHostDoctor exits 1 with a named reason for a token-copy mismatch', async () => {
  const m = await doctorServer('tok-bot-maint-1');
  try {
    // The credentials copy is a token the server does not register.
    const env = doctorHome(m.url, 'tok-bot-maint-1:bot-maint', 'tok-bot-maint-OTHER');
    const out: string[] = [];
    const code = await runHostDoctor(['--allow-no-harnesses'], { out: (s) => out.push(s), err: () => {} }, env);
    assert.equal(code, 1);
    assert.match(out.join(''), /bot maint: FAIL — token in .*bot-credentials\.json is not registered in MERCURY_API_TOKENS/);
  } finally {
    await m.close();
  }
});
