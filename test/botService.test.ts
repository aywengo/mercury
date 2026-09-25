import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  botLaunchdLabel,
  botPlist,
  botPlistPath,
  botServiceName,
  botUnit,
  botUnitPath,
  botWrapper,
  botWrapperPath,
  installBotService,
  parseBotServiceInstallArgs,
  parseBotServiceUninstallArgs,
  removeBotCredential,
  removeBotTokenFromEnv,
  teardownConsequence,
  uninstallBotService,
} from '../src/host/bots/service.ts';
import { tempDir } from './helpers.ts';

// ---- deterministic unit text ----

const ENV_FILE = '/host/config/mercury/mercury.env';
const BIN = '/host/bin/mercury';
const STATE = '/host/state';

test('bot unit text is deterministic and runs the alias run loop', () => {
  const unit = botUnit(BIN, ENV_FILE, 'nightly');
  assert.match(unit, /ExecStart=\/host\/bin\/mercury host bot run --alias nightly/);
  assert.match(unit, /EnvironmentFile=\/host\/config\/mercury\/mercury\.env/);
  assert.equal(unit, botUnit(BIN, ENV_FILE, 'nightly'), 'same inputs, same unit text');
  const wrapper = botWrapper(BIN, ENV_FILE, 'nightly');
  assert.match(wrapper, /exec "\/host\/bin\/mercury" host bot run --alias "nightly"/);
  assert.doesNotMatch(wrapper, /tok-bot/, 'no token material in the wrapper');
  const plist = botPlist('/w/run-nightly.sh', STATE, 'nightly');
  assert.match(plist, /<string>com\.mercury\.bot\.nightly<\/string>/);
  assert.equal(plist, botPlist('/w/run-nightly.sh', STATE, 'nightly'), 'same inputs, same plist text');
});

// ---- arg parsing ----

test('install/uninstall arg parsing: --alias required, flags collected, unknown refused', () => {
  assert.deepEqual(parseBotServiceInstallArgs(['--alias', 'ops', '--dry-run']), { alias: 'ops', dryRun: true });
  assert.deepEqual(parseBotServiceInstallArgs(['--alias=ops']), { alias: 'ops', dryRun: false });
  assert.throws(() => parseBotServiceInstallArgs([]), /--alias <a> is required/);
  assert.throws(() => parseBotServiceInstallArgs(['--alias', 'ops', '--bogus']), /unknown argument/);
  const u = parseBotServiceUninstallArgs(['--alias=ops', '--yes', '--keep-env']);
  assert.equal(u.alias, 'ops');
  assert.equal(u.yes, true);
  assert.equal(u.keepEnv, true);
  assert.equal(u.reassignOwner, null);
  assert.equal(parseBotServiceUninstallArgs(['--alias=ops', '--reassign-runs', 'alice']).reassignOwner, 'alice');
  assert.throws(() => parseBotServiceUninstallArgs(['--alias=ops', '--reassign-runs']), /requires an owner value/, 'missing value is a usage error, not a refusal');
  assert.throws(() => parseBotServiceUninstallArgs(['--alias=ops', '--reassign-runs=']), /requires an owner value/);
  assert.throws(() => parseBotServiceUninstallArgs(['--alias=ops', '--bogus']), /unknown argument/);
});

// ---- install (darwin choreography, mirroring hostService.test.ts) ----

test('install (darwin): print -> bootstrap (nothing loaded yet); re-run bootouts first (#650 pattern)', async () => {
  const dir = tempDir('bot-svc-install-');
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) [ "$LAUNCHCTL_LOADED" = "1" ] && exit 0 || exit 1 ;;
  bootout|bootstrap) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  writeFileSync(join(bin, 'which'), '#!/bin/sh\necho /fake/mercury\n');
  chmodSync(join(bin, 'which'), 0o755);
  const home = join(dir, 'home');
  const cfg = join(home, '.config');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\n');
  const io = { out: () => {}, err: () => {} };
  const env = {
    XDG_CONFIG_HOME: cfg,
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LAUNCHCTL_LOG: join(dir, 'launchctl.log'),
  };
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const plistPath = join(home, 'Library', 'LaunchAgents', 'com.mercury.bot.nightly.plist');
  const savedPath = process.env.PATH;
  const savedLog = process.env.LAUNCHCTL_LOG;
  const savedHome = process.env.HOME;
  process.env.PATH = env.PATH;
  process.env.LAUNCHCTL_LOG = env.LAUNCHCTL_LOG;
  process.env.HOME = home;
  try {
    let code = installBotService('darwin', 'nightly', io, env as NodeJS.ProcessEnv, false);
    assert.equal(code, 0, 'first install exits 0');
    const firstCalls = readFileSync(join(dir, 'launchctl.log'), 'utf8').trim().split('\n');
    assert.deepEqual(firstCalls, [
      `print gui/${uid}/com.mercury.bot.nightly`,
      `bootstrap gui/${uid} ${plistPath}`,
    ], 'nothing loaded: print decides, then straight bootstrap (no bootout)');
    assert.ok(existsSync(plistPath));
    assert.ok(existsSync(join(dir, 'state', 'mercury', 'bots', 'run-nightly.sh')));
    // Re-run with the agent "loaded": print -> bootout -> bootstrap.
    process.env.LAUNCHCTL_LOADED = '1';
    rmSync(join(dir, 'launchctl.log'));
    code = installBotService('darwin', 'nightly', io, env as NodeJS.ProcessEnv, false);
    assert.equal(code, 0);
    const secondCalls = readFileSync(join(dir, 'launchctl.log'), 'utf8').trim().split('\n');
    assert.deepEqual(secondCalls, [
      `print gui/${uid}/com.mercury.bot.nightly`,
      `bootout gui/${uid}/com.mercury.bot.nightly`,
      `bootstrap gui/${uid} ${plistPath}`,
    ]);
  } finally {
    process.env.PATH = savedPath;
    process.env.LAUNCHCTL_LOG = savedLog;
    process.env.HOME = savedHome;
    delete process.env.LAUNCHCTL_LOADED;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install --dry-run prints the unit and writes nothing', () => {
  const dir = tempDir('bot-svc-dry-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  const io = { out: (s: string) => { outBuf += s; }, err: () => {} };
  let outBuf = '';
  const env = { XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: join(dir, 'state'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv;
  const code = installBotService('linux', 'nightly', io, env, true);
  assert.equal(code, 0);
  assert.match(outBuf, /ExecStart=.* host bot run --alias nightly/);
  assert.ok(!existsSync(botUnitPath('nightly', env)), 'dry-run wrote nothing');
  rmSync(dir, { recursive: true, force: true });
});

// ---- env token removal ----

test('removeBotTokenFromEnv removes only the bot entry, preserving the rest', () => {
  const envText = [
    'MERCURY_ADMIN_TOKEN=tok-admin-1',
    'MERCURY_API_TOKENS=tok-alice:alice, tok-bot-nightly-abc:bot-nightly, tok-bot-ops-def:bot-ops',
    'MERCURY_HARNESSES=claude-code',
    '',
  ].join('\n');
  const { text, removed } = removeBotTokenFromEnv(envText, 'nightly');
  assert.equal(removed, 1);
  assert.match(text, /tok-alice:alice/);
  assert.match(text, /tok-bot-ops-def:bot-ops/);
  assert.doesNotMatch(text, /bot-nightly/);
  assert.match(text, /MERCURY_ADMIN_TOKEN=tok-admin-1/);
  assert.match(text, /MERCURY_HARNESSES=claude-code/);
  // No entry for that alias: nothing changes.
  const r2 = removeBotTokenFromEnv(envText, 'ghost');
  assert.equal(r2.removed, 0);
  assert.equal(r2.text, envText);
});

// ---- uninstall ----

function setupBot(dir: string): NodeJS.ProcessEnv {
  const cfg = join(dir, 'cfg');
  const state = join(dir, 'state');
  mkdirSync(join(cfg, 'mercury', 'bots'), { recursive: true });
  mkdirSync(join(state, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'bots', 'nightly.json'), JSON.stringify({ api: { url: 'http://127.0.0.1:3000' }, schedule: { tasks: [] } }));
  writeFileSync(join(cfg, 'mercury', 'bot-credentials.json'), JSON.stringify({ nightly: { api: 'tok-bot-nightly-1' }, other: { api: 'tok-bot-other-2' } }), { mode: 0o600 });
  writeFileSync(join(state, 'mercury', 'bots', 'nightly.state.json'), JSON.stringify({ lastTickMs: 1 }));
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-alice:alice, tok-bot-nightly-1:bot-nightly\n');
  return { XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: state, HOME: join(dir, 'home') } as NodeJS.ProcessEnv;
}

test('uninstall without --yes prints the plan and the §17.7 consequence, writes nothing', () => {
  const dir = tempDir('bot-svc-un1-');
  const env = setupBot(dir);
  let outBuf = '';
  let errBuf = '';
  const io = { out: (s: string) => { outBuf += s; }, err: (s: string) => { errBuf += s; } };
  const code = uninstallBotService('linux', 'nightly', io, env, { yes: false, keepEnv: false, reassignOwner: null });
  assert.equal(code, 1, 'refusal exits 1');
  assert.match(outBuf, /Plan:/);
  assert.match(outBuf, /Teardown consequence \(§17\.7\): Runs owned by bot-nightly remain/);
  assert.match(errBuf, /nothing written/);
  assert.ok(existsSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bots', 'nightly.json')), 'config kept');
  assert.ok(existsSync(join(env.XDG_STATE_HOME!, 'mercury', 'bots', 'nightly.state.json')), 'state kept');
  assert.match(readFileSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'mercury.env'), 'utf8'), /bot-nightly/, 'env untouched');
  rmSync(dir, { recursive: true, force: true });
});

test('uninstall --yes (linux) removes the unit, bot files, credentials entry and env entry; §17.7 printed', () => {
  const dir = tempDir('bot-svc-un2-');
  const env = setupBot(dir);
  const unitPath = botUnitPath('nightly', env);
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, botUnit(BIN, ENV_FILE, 'nightly'));
  // A fake systemctl that exits 0 and records nothing (unit exists on disk is what matters here).
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  let outBuf = '';
  const io = { out: (s: string) => { outBuf += s; }, err: () => {} };
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  try {
    const code = uninstallBotService('linux', 'nightly', io, env, { yes: true, keepEnv: false, reassignOwner: null });
    assert.equal(code, 0);
    assert.match(outBuf, /Teardown consequence \(§17\.7\): Runs owned by bot-nightly remain/);
    assert.ok(!existsSync(unitPath), 'unit removed');
    assert.ok(!existsSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bots', 'nightly.json')), 'config removed');
    assert.ok(!existsSync(join(env.XDG_STATE_HOME!, 'mercury', 'bots', 'nightly.state.json')), 'state removed');
    const creds = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bot-credentials.json'), 'utf8'));
    assert.deepEqual(creds, { other: { api: 'tok-bot-other-2' } }, 'other bots preserved');
    const envText = readFileSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'mercury.env'), 'utf8');
    assert.doesNotMatch(envText, /bot-nightly/);
    assert.match(envText, /tok-alice:alice/);
    assert.match(outBuf, /Removed the bot-nightly entry from MERCURY_API_TOKENS/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mercury.env rewrite repairs a drifted (0644) mode after removing the entry (round-3 review)', () => {
  const dir = tempDir('bot-svc-envmode-');
  const env = setupBot(dir);
  const envFile = join(env.XDG_CONFIG_HOME!, 'mercury', 'mercury.env');
  chmodSync(envFile, 0o644);
  const io = { out: () => {}, err: () => {} };
  const code = uninstallBotService('linux', 'nightly', io, env, { yes: true, keepEnv: false, reassignOwner: null });
  assert.equal(code, 0);
  assert.equal(statSync(envFile).mode & 0o777, 0o600, 'the rewrite repairs the drifted mode');
  assert.doesNotMatch(readFileSync(envFile, 'utf8'), /bot-nightly/);
  rmSync(dir, { recursive: true, force: true });
});

test('uninstall --yes --keep-env keeps MERCURY_API_TOKENS; a missing entry says so', () => {
  const dir = tempDir('bot-svc-un3-');
  const env = setupBot(dir);
  let outBuf = '';
  const io = { out: (s: string) => { outBuf += s; }, err: () => {} };
  const code = uninstallBotService('linux', 'nightly', io, env, { yes: true, keepEnv: true, reassignOwner: null });
  assert.equal(code, 0);
  const envText = readFileSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'mercury.env'), 'utf8');
  assert.match(envText, /tok-bot-nightly-1:bot-nightly/, '--keep-env leaves the env entry');
  assert.doesNotMatch(outBuf, /MERCURY_API_TOKENS/);
  rmSync(dir, { recursive: true, force: true });
  // Missing entry path.
  const dir2 = tempDir('bot-svc-un4-');
  const env2 = setupBot(dir2);
  // Remove the env entry from the fixture so uninstall reports "nothing to remove there".
  const envFile = join(env2.XDG_CONFIG_HOME!, 'mercury', 'mercury.env');
  writeFileSync(envFile, 'MERCURY_PORT=3999\n');
  let outBuf2 = '';
  const io2 = { out: (s: string) => { outBuf2 += s; }, err: () => {} };
  const code2 = uninstallBotService('linux', 'nightly', io2, env2, { yes: true, keepEnv: false, reassignOwner: null });
  assert.equal(code2, 0);
  assert.match(outBuf2, /No bot-nightly entry found in MERCURY_API_TOKENS/);
  rmSync(dir2, { recursive: true, force: true });
});

test('uninstall is idempotent on a host where nothing is installed', () => {
  const dir = tempDir('bot-svc-un5-');
  const env = setupBot(dir);
  // No unit written: uninstall still exits 0, prints "not installed", removes the files.
  let outBuf = '';
  const io = { out: (s: string) => { outBuf += s; }, err: () => {} };
  const code = uninstallBotService('linux', 'nightly', io, env, { yes: true, keepEnv: false, reassignOwner: null });
  assert.equal(code, 0);
  assert.match(outBuf, /mercury-bot-nightly\.service is not installed/);
  assert.ok(!existsSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bots', 'nightly.json')));
  rmSync(dir, { recursive: true, force: true });
});

test('a malformed credentials file fails the uninstall loudly instead of leaving the token (round-5 review)', () => {
  const dir = tempDir('bot-svc-badcred-');
  const env = setupBot(dir);
  writeFileSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bot-credentials.json'), '{not json');
  let errBuf = '';
  const io = { out: () => {}, err: (s: string) => { errBuf += s; } };
  const code = uninstallBotService('linux', 'nightly', io, env, { yes: true, keepEnv: false, reassignOwner: null });
  assert.equal(code, 1);
  assert.match(errBuf, /cannot update .*bot-credentials\.json: not valid JSON/);
  assert.match(errBuf, /remove the 'nightly' entry by hand/);
  rmSync(dir, { recursive: true, force: true });
});

test('--reassign-runs refuses clearly (no owner-transfer API) and writes nothing', () => {
  const dir = tempDir('bot-svc-un6-');
  const env = setupBot(dir);
  let errBuf = '';
  const io = { out: () => {}, err: (s: string) => { errBuf += s; } };
  let outBuf = '';
  const io2 = { out: (s: string) => { outBuf += s; }, err: (s: string) => { errBuf += s; } };
  const code = uninstallBotService('linux', 'nightly', io2, env, { yes: true, keepEnv: false, reassignOwner: 'alice' });
  assert.equal(code, 1);
  assert.match(errBuf, /--reassign-runs is not supported yet/);
  assert.match(errBuf, /#760/);
  assert.match(outBuf, /Teardown consequence \(§17\.7\): Runs owned by bot-nightly remain/, 'the consequence is printed even on the refusal path');
  assert.ok(existsSync(join(env.XDG_CONFIG_HOME!, 'mercury', 'bots', 'nightly.json')), 'nothing removed');
  rmSync(dir, { recursive: true, force: true });
});

test('removeBotCredential removes only the alias entry and keeps 0600', () => {
  const dir = tempDir('bot-svc-cred-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  const cp = join(cfg, 'mercury', 'bot-credentials.json');
  writeFileSync(cp, JSON.stringify({ a: { api: 't1' }, b: { api: 't2' } }), { mode: 0o600 });
  assert.equal(removeBotCredential('a', { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv), true);
  const after = JSON.parse(readFileSync(cp, 'utf8'));
  assert.deepEqual(after, { b: { api: 't2' } });
  assert.equal(statSync(cp).mode & 0o777, 0o600, 'the shared credentials file stays 0600');
  assert.equal(removeBotCredential('ghost', { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv), false);
  rmSync(dir, { recursive: true, force: true });
});

test('removeBotCredential enforces 0600 on an existing file whose mode drifted (round-2 review)', () => {
  const dir = tempDir('bot-svc-cred2-');
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  const cp = join(cfg, 'mercury', 'bot-credentials.json');
  writeFileSync(cp, JSON.stringify({ a: { api: 't1' }, b: { api: 't2' } }), { mode: 0o644 });
  assert.equal(removeBotCredential('a', { XDG_CONFIG_HOME: cfg } as NodeJS.ProcessEnv), true);
  assert.equal(statSync(cp).mode & 0o777, 0o600, 'the rewrite repairs a drifted mode');
  rmSync(dir, { recursive: true, force: true });
});

test('teardownConsequence names the owner and the §17.7 rule', () => {
  const s = teardownConsequence('nightly');
  assert.match(s, /bot-nightly/);
  assert.match(s, /admin or observer token/);
});

test('subprocess smoke: `host bot service install --alias x --dry-run` exits 0', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const dir = tempDir('bot-svc-smoke-');
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_STATE_HOME: join(dir, 'state'), HOME: join(dir, 'home') };
  try {
    await run('node', ['src/cli.ts', 'host', 'bot', 'service', 'install', '--alias', 'x', '--dry-run'], { env, timeout: 30_000, cwd: join(import.meta.dirname, '..') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('install/uninstall refuse an alias that violates the §4.1 contract (path safety)', () => {
  const dir = tempDir('bot-svc-alias-');
  const env = { XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_STATE_HOME: join(dir, 'state'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv;
  const io = { out: () => {}, err: () => {} };
  assert.throws(() => installBotService('linux', '../escape', io, env, false), /bot alias must match/);
  assert.throws(() => uninstallBotService('linux', 'UPPER', io, env, { yes: true, keepEnv: false, reassignOwner: null }), /bot alias must match/);
  assert.ok(!existsSync(join(dir, 'cfg', 'systemd')), 'nothing written for an invalid alias');
  rmSync(dir, { recursive: true, force: true });
});

test('removeBotTokenFromEnv refuses malformed entries by index without echoing the token', () => {
  const bad = 'MERCURY_API_TOKENS=tok-alice:alice, tok-no-colon\n';
  assert.throws(() => removeBotTokenFromEnv(bad, 'nightly'), /entry 1 .* not 'token:owner'/);
  // parseTokens parity: both halves must be non-empty, exactly one colon.
  assert.throws(() => removeBotTokenFromEnv('MERCURY_API_TOKENS=tok:\n', 'nightly'), /entry 0 .* not 'token:owner'/);
  assert.throws(() => removeBotTokenFromEnv('MERCURY_API_TOKENS=:bot-nightly\n', 'nightly'), /entry 0 .* not 'token:owner'/);
  assert.throws(() => removeBotTokenFromEnv('MERCURY_API_TOKENS=a:b:c\n', 'nightly'), /not 'token:owner'/);
  try {
    removeBotTokenFromEnv(bad, 'nightly');
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /tok-alice|tok-no-colon/, 'no token material in the error');
  }
});
