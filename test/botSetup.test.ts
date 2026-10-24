// `mercury host setup`'s bots step (docs/dispatcher-bot-design.md §11, §4.2, §8.5; B4, #915).
//
// The step's contract: one command writes the starter config, the bot's credentials copy and the
// server-side MERCURY_API_TOKENS entry, so the two token copies cannot drift at creation. It never
// overwrites an existing config, never prints a token, and refuses the observer/brain postures the
// tree cannot run (B2/B3) after stating the §8.5 blast radius.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers.ts';
import { botConfigPath, loadBotConfig, botsDir } from '../src/host/bots/config.ts';
import { apiTokenForOwner, botCredentialsPath, readBotCredentials, registeredOwnerForToken } from '../src/host/bots/credentials.ts';
import {
  BLAST_RADIUS_SENTENCE,
  botProvisionSummary,
  generateBotToken,
  planBotProvision,
  starterBotConfig,
  writeBotProvision,
} from '../src/host/bots/provision.ts';
import { envDiff, envFilePath, runHostSetup, validateAnswers, type HostSetupAnswers } from '../src/host/setup.ts';
import type { HarnessProbeResult } from '../src/host/probe.ts';

const ROOT = join(import.meta.dirname, '..');

function probeOk(...ids: string[]): HarnessProbeResult[] {
  return ids.map((id) => ({
    id, label: id, binary: id, version: '9.9.9', versionRaw: '9.9.9', minVersion: null,
    status: 'ok' as const, configPath: '/nonexistent', configExists: false, auth: 'unknown' as const,
  }));
}

/** An isolated XDG config/state home; bot files and mercury.env land under it. */
function botEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = tempDir('mercury-botsetup-');
  return { env: { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, 'state') }, dir };
}

function writeCredentials(dir: string, json: unknown, mode = 0o600): void {
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const p = join(dir, 'mercury', 'bot-credentials.json');
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n', { mode });
  chmodSync(p, mode);
}

test('starter config passes the B0-5 validator unchanged', () => {
  const { env, dir } = botEnv();
  const cfg = starterBotConfig('maint', 'primeagent');
  mkdirSync(botsDir(env), { recursive: true });
  writeFileSync(botConfigPath('maint', env), JSON.stringify(cfg));
  const loaded = loadBotConfig('maint', env);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0]!.name, 'maintenance');
  assert.equal(loaded.tasks[0]!.template.agent, 'primeagent');
  assert.deepEqual(loaded.warnings, []);
  assert.ok(existsSync(join(dir, 'mercury', 'bots', 'maint.json')));
});

test('generateBotToken: tok-bot-<alias>- prefix, 32 hex chars, unique', () => {
  const a = generateBotToken('maint');
  const b = generateBotToken('maint');
  assert.match(a, /^tok-bot-maint-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.throws(() => generateBotToken('../x'), /bot alias must match/);
});

test('plan: a fresh host generates one token for both copies', () => {
  const { env } = botEnv();
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: undefined });
  assert.equal(plan.tokenSource, 'generated');
  assert.equal(plan.configAction, 'write');
  assert.equal(plan.credentialsAction, 'write');
  assert.equal(plan.apiTokensValue, `${plan.token}:bot-maint`);
  assert.equal(apiTokenForOwner(plan.apiTokensValue, 'bot-maint'), plan.token);
  assert.equal(registeredOwnerForToken(plan.token, plan.apiTokensValue), 'bot-maint');
});

test('plan: an existing credentials token is reused and registered in the env copy', () => {
  const { env } = botEnv();
  writeCredentials(env.XDG_CONFIG_HOME!, { maint: { api: 'tok-bot-maint-existing' } });
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: 'tok-alice:alice' });
  assert.equal(plan.token, 'tok-bot-maint-existing');
  assert.equal(plan.tokenSource, 'credentials');
  assert.equal(plan.credentialsAction, 'unchanged');
  assert.equal(plan.apiTokensValue, 'tok-alice:alice,tok-bot-maint-existing:bot-maint');
});

test('plan: an env-registered token installs the missing credentials copy', () => {
  const { env } = botEnv();
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: 'tok-bot-maint-from-env:bot-maint' });
  assert.equal(plan.token, 'tok-bot-maint-from-env');
  assert.equal(plan.tokenSource, 'env');
  assert.equal(plan.credentialsAction, 'write');
});

test('plan: two copies that already disagree are refused by name, without echoing either token', () => {
  const { env } = botEnv();
  writeCredentials(env.XDG_CONFIG_HOME!, { maint: { api: 'tok-bot-maint-aaaa' } });
  assert.throws(
    () => planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: 'tok-bot-maint-bbbb:bot-maint' }),
    (err: Error) => {
      assert.match(err.message, /hold different tokens for bot-maint/);
      assert.match(err.message, /bot-credentials\.json/);
      assert.match(err.message, /MERCURY_API_TOKENS/);
      assert.ok(!err.message.includes('aaaa') && !err.message.includes('bbbb'), 'no token value in the refusal');
      return true;
    },
  );
});

test('plan: an existing config is kept, never overwritten', () => {
  const { env } = botEnv();
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: undefined, configExists: true });
  assert.equal(plan.configAction, 'keep');
});

test('write: config and credentials land 0600, other aliases preserved', () => {
  const { env } = botEnv();
  writeCredentials(env.XDG_CONFIG_HOME!, { nightly: { api: 'tok-nightly' } });
  const plan = planBotProvision({ alias: 'maint', harness: 'hermes', posture: 'scheduler', env, apiTokensRaw: undefined });
  writeBotProvision(plan, env);
  const cfgPath = botConfigPath('maint', env);
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
  const credsPath = botCredentialsPath(env);
  assert.equal(statSync(credsPath).mode & 0o777, 0o600);
  const creds = JSON.parse(readFileSync(credsPath, 'utf8')) as Record<string, { api: string }>;
  assert.equal(creds.nightly!.api, 'tok-nightly', 'another bot must survive the write');
  assert.equal(creds.maint!.api, plan.token);
  assert.equal(readBotCredentials('maint', env).api, plan.token);
});

test('write: an existing config file is left byte-for-byte intact', () => {
  const { env } = botEnv();
  mkdirSync(botsDir(env), { recursive: true });
  const edited = '{"description":"hand-edited","schedule":{"tasks":[{"name":"x","cron":"0 4 * * *","template":{"task":"t"}}]}}';
  writeFileSync(botConfigPath('maint', env), edited);
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: undefined });
  writeBotProvision(plan, env);
  assert.equal(readFileSync(botConfigPath('maint', env), 'utf8'), edited);
});

test('summary never carries the token value', () => {
  const { env } = botEnv();
  const plan = planBotProvision({ alias: 'maint', harness: 'primeagent', posture: 'scheduler', env, apiTokensRaw: undefined });
  const summary = botProvisionSummary(plan);
  assert.ok(summary.includes(`<set, ${plan.token.length} chars>`));
  assert.ok(!summary.includes(plan.token));
});

test('envDiff: MERCURY_API_TOKENS values are redacted like every other credential', () => {
  const diff = envDiff('MERCURY_API_TOKENS=tok-a:alice\n', 'MERCURY_API_TOKENS=tok-a:alice,tok-b:bot-maint\n');
  assert.ok(diff.includes('MERCURY_API_TOKENS=<redacted'), diff);
  assert.ok(!diff.includes('tok-b'), 'a bot token must never reach a terminal through the diff');
});

test('validateAnswers: an untrusted harnesses value with the bots step on is an error, not a crash', () => {
  const a = {
    hostName: 'h', dataDir: '/d', workspaceDir: '/w', retentionDays: 7, adminToken: 'a'.repeat(64),
    atlasEnabled: false, atlasUrl: '', atlasToken: '', atlasProject: '', bindHost: '',
    harnesses: 42, layaEnabled: false, layaUrl: '',
    botEnabled: true, botAlias: 'maint', botHarness: 'primeagent', botPosture: 'scheduler',
  } as unknown as HostSetupAnswers;
  const errors = validateAnswers(a);
  assert.ok(errors.some((e) => e.startsWith('harnesses:')), errors.join('; '));
  assert.ok(errors.some((e) => e.startsWith('botHarness:')), errors.join('; '));
});

// ---------- the wizard path ----------

function answersFileFor(dir: string, over: Record<string, unknown> = {}): string {
  const p = join(dir, 'answers.json');
  writeFileSync(p, JSON.stringify({
    harnesses: ['primeagent'],
    adminToken: 'a'.repeat(64),
    botEnabled: true,
    botAlias: 'maint',
    botHarness: 'primeagent',
    ...over,
  }));
  return p;
}

test('wizard: --non-interactive writes the bot config, both token copies, and never prints the token', async () => {
  const { env, dir } = botEnv();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFileFor(dir)], {
    out: (s) => out.push(s), err: (s) => err.push(s), probe: async () => probeOk('primeagent'),
  }, env);
  assert.equal(code, 0, err.join(''));
  const envText = readFileSync(envFilePath(env), 'utf8');
  const apiTokens = /MERCURY_API_TOKENS=(.*)/.exec(envText)?.[1];
  assert.ok(apiTokens, 'the server-side copy must be in mercury.env');
  assert.equal(apiTokenForOwner(apiTokens, 'bot-maint'), readBotCredentials('maint', env).api);
  const token = readBotCredentials('maint', env).api!;
  assert.ok(!out.join('').includes(token), 'the bot token must never be printed');
  assert.ok(!err.join('').includes(token));
  assert.ok(existsSync(botConfigPath('maint', env)));
  assert.equal(loadBotConfig('maint', env).tasks[0]!.name, 'maintenance');
  assert.ok(out.join('').includes('bot: maint'));
});

test('wizard: --dry-run prints the plan and writes neither the env file nor a bot file', async () => {
  const { env, dir } = botEnv();
  const out: string[] = [];
  const code = await runHostSetup(['--non-interactive', '--dry-run', '--answers', answersFileFor(dir)], {
    out: (s) => out.push(s), err: () => {}, probe: async () => probeOk('primeagent'),
  }, env);
  assert.equal(code, 0);
  assert.ok(!existsSync(envFilePath(env)));
  assert.ok(!existsSync(botConfigPath('maint', env)));
  assert.ok(!existsSync(botCredentialsPath(env)));
  assert.ok(out.join('').includes('bot: maint'));
  assert.ok(!out.join('').includes('tok-bot-maint-'), 'no token value in a dry-run');
});

test('wizard: the observer posture is refused with the §8.5 sentence and writes nothing', async () => {
  const { env, dir } = botEnv();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFileFor(dir, { botPosture: 'observer' })], {
    out: (s) => out.push(s), err: (s) => err.push(s), probe: async () => probeOk('primeagent'),
  }, env);
  assert.equal(code, 1);
  assert.ok(err.join('').includes(BLAST_RADIUS_SENTENCE), err.join(''));
  assert.ok(err.join('').includes('B2/B3'));
  assert.ok(!existsSync(envFilePath(env)), 'a refused posture writes nothing');
  assert.ok(!existsSync(botConfigPath('maint', env)));
});

test('wizard: a re-run keeps a hand-edited config and reuses the existing token', async () => {
  const { env, dir } = botEnv();
  const answers = answersFileFor(dir);
  const io = { out: () => {}, err: () => {}, probe: async () => probeOk('primeagent') };
  assert.equal(await runHostSetup(['--non-interactive', '--yes', '--answers', answers], io, env), 0);
  const edited = readFileSync(botConfigPath('maint', env), 'utf8').replace('Daily maintenance', 'Hand-tuned maintenance');
  writeFileSync(botConfigPath('maint', env), edited);
  const token = readBotCredentials('maint', env).api;
  assert.equal(await runHostSetup(['--non-interactive', '--yes', '--answers', answers], io, env), 0);
  assert.equal(readFileSync(botConfigPath('maint', env), 'utf8'), edited, 'the config must not be overwritten');
  assert.equal(readBotCredentials('maint', env).api, token, 'a re-run must not rotate the token');
});

test('wizard: a pre-existing token disagreement is a named refusal before any write', async () => {
  const { env, dir } = botEnv();
  writeCredentials(dir, { maint: { api: 'tok-bot-maint-aaaa' } });
  const envPath = envFilePath(env);
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(envPath, 'MERCURY_API_TOKENS=tok-bot-maint-bbbb:bot-maint\n', { mode: 0o600 });
  chmodSync(envPath, 0o600);
  const before = readFileSync(envPath, 'utf8');
  const err: string[] = [];
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFileFor(dir)], {
    out: () => {}, err: (s) => err.push(s), probe: async () => probeOk('primeagent'),
  }, env);
  assert.equal(code, 1);
  assert.match(err.join(''), /hold different tokens for bot-maint/);
  assert.equal(readFileSync(envPath, 'utf8'), before, 'nothing was written');
  assert.ok(!existsSync(botConfigPath('maint', env)));
});

test('wizard: other MERCURY_API_TOKENS entries survive the bots step', async () => {
  const { env, dir } = botEnv();
  const envPath = envFilePath(env);
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(envPath, 'MERCURY_API_TOKENS=tok-alice:alice\n', { mode: 0o600 });
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFileFor(dir)], {
    out: () => {}, err: () => {}, probe: async () => probeOk('primeagent'),
  }, env);
  assert.equal(code, 0);
  const apiTokens = /MERCURY_API_TOKENS=(.*)/.exec(readFileSync(envPath, 'utf8'))?.[1];
  assert.equal(apiTokenForOwner(apiTokens, 'alice'), 'tok-alice');
  assert.equal(apiTokenForOwner(apiTokens, 'bot-maint'), readBotCredentials('maint', env).api);
});

test('the wizard\'s own next command works: `host bot validate` reads mercury.env, not the shell', () => {
  // The starter config's description tells the operator to run `mercury host bot validate
  // --alias <a>`; the summary tells them `MERCURY_API_TOKENS: <owner> registered`. Both are only
  // true if validate reads the file the wizard wrote. It used to read `process.env` alone, so a
  // correct install reported `agreement FAIL` to anyone who had not sourced mercury.env (#915).
  const { env, dir } = botEnv();
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  const token = 'tok-bot-maint-0123456789abcdef0123456789abcdef';
  writeFileSync(botConfigPath('maint', env), JSON.stringify(starterBotConfig('maint', 'primeagent')));
  writeCredentials(dir, { maint: { api: token } });
  writeFileSync(envFilePath(env), `MERCURY_API_TOKENS=${token}:bot-maint\n`, { mode: 0o600 });
  const spawned = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'host', 'bot', 'validate', '--alias', 'maint'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    // Deliberately no MERCURY_API_TOKENS: the operator's shell does not have one either.
    env: { ...env, PATH: process.env.PATH ?? '' },
  });
  assert.equal(spawned.status, 0, `${spawned.stdout}${spawned.stderr}`);
  assert.match(spawned.stdout, /agreement ok: both copies register owner 'bot-maint'/);
  assert.ok(!spawned.stdout.includes(token), 'the token value never reaches the terminal');
});
