// Bot config + credentials validation fixtures (B0-5, #733; docs/dispatcher-bot-design.md §4.1,
// §4.2, §12). Every malformed config in the fixture set must be refused WITH A NAMED FIELD --
// a validation error that does not name its field sends the operator hunting through a JSON tree
// at 03:00 for the one key the validator already knows is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { loadBotConfig, botConfigPath } from '../src/host/bots/config.ts';
import { botOwnerId } from '../src/host/bots/keys.ts';
import { botCredentialsPath, readBotCredentials, registeredOwnerForToken } from '../src/host/bots/credentials.ts';

function withBots(files: Record<string, unknown>, creds?: { json?: unknown; mode?: number }): {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const root = tempDir('mercury-botcfg-');
  const botsDir = join(root, 'mercury', 'bots');
  mkdirSync(botsDir, { recursive: true });
  for (const [alias, cfg] of Object.entries(files)) {
    writeFileSync(join(botsDir, `${alias}.json`), JSON.stringify(cfg));
  }
  if (creds) {
    const cp = join(root, 'mercury', 'bot-credentials.json');
    writeFileSync(cp, JSON.stringify(creds.json ?? {}));
    chmodSync(cp, creds.mode ?? 0o600);
  }
  return {
    env: { XDG_CONFIG_HOME: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const OK_CFG = {
  description: 'nightly maintenance',
  api: { url: 'http://127.0.0.1:3000', timeoutMs: 30000 },
  schedule: {
    tasks: [
      {
        name: 'nightly-gc-audit',
        cron: '17 3 * * *',
        tz: 'UTC',
        template: { task: 'Audit workspace GC retention', skills: ['workspace-audit'] },
        singleFlight: true,
        onMiss: 'skip',
      },
    ],
  },
};

test('a valid config loads with defaults applied (singleFlight true, onMiss skip)', () => {
  const { env, cleanup } = withBots({ maint: OK_CFG });
  try {
    const cfg = loadBotConfig('maint', env);
    assert.equal(cfg.alias, 'maint');
    assert.equal(cfg.tasks.length, 1);
    assert.equal(cfg.tasks[0]!.singleFlight, true);
    assert.equal(cfg.tasks[0]!.onMiss, 'skip');
    assert.deepEqual(cfg.warnings, []);
  } finally {
    cleanup();
  }
});

test('fixture set: each malformed config is refused with a named field', () => {
  const fixtures: { label: string; cfg: unknown; field: RegExp; message?: RegExp }[] = [
    { label: 'typoed top-level key suggests the real one', cfg: { ...OK_CFG, schdule: OK_CFG.schedule }, field: /\(root\)/, message: /unknown key 'schdule' \(did you mean 'schedule'\?\)/ },
    { label: 'reserved triggers refused for B2', cfg: { ...OK_CFG, triggers: [] }, field: /triggers/, message: /not supported before B2/ },
    { label: 'reserved brain refused for B3', cfg: { ...OK_CFG, brain: { provider: 'x' } }, field: /brain/, message: /not supported before B3/ },
    { label: 'missing schedule', cfg: { description: 'x' }, field: /schedule/, message: /required/ },
    { label: 'empty tasks', cfg: { schedule: { tasks: [] } }, field: /schedule\.tasks/, message: /non-empty/ },
    { label: 'duplicate task names', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' } },
      { name: 'a', cron: '* * * * *', template: { task: 'y' } },
    ] } }, field: /schedule\.tasks\[1\]\.name/, message: /duplicate task name/ },
    { label: 'bad cron named at validate time', cfg: { schedule: { tasks: [
      { name: 'a', cron: '99 * * * *', template: { task: 'x' } },
    ] } }, field: /schedule\.tasks\[0\]\.cron/, message: /minute/ },
    { label: 'bad tz', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', tz: 'Mars/Olympus', template: { task: 'x' } },
    ] } }, field: /schedule\.tasks\[0\]\.tz/, message: /must be 'UTC', 'local', or a fixed offset/ },
    { label: 'template without task text', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { agent: 'hermes' } },
    ] } }, field: /schedule\.tasks\[0\]\.template\.task/, message: /non-empty/ },
    { label: 'task name with a colon (key ambiguity)', cfg: { schedule: { tasks: [
      { name: 'we:ird', cron: '* * * * *', template: { task: 'x' } },
    ] } }, field: /schedule\.tasks\[0\]\.name/, message: /must match/ },
    { label: 'bad onMiss value', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, onMiss: 'explode' },
    ] } }, field: /schedule\.tasks\[0\]\.onMiss/, message: /skip, collapse, run/ },
    { label: 'negative maxCatchUp', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, maxCatchUp: -1 },
    ] } }, field: /schedule\.tasks\[0\]\.maxCatchUp/, message: /non-negative integer/ },
    { label: 'bad api url', cfg: { ...OK_CFG, api: { url: 'ftp://x' } }, field: /api\.url/, message: /http/ },
    { label: 'bad timeout', cfg: { ...OK_CFG, api: { url: 'http://x', timeoutMs: 0 } }, field: /api\.timeoutMs/, message: /positive integer/ },
  ];
  for (const fx of fixtures) {
    const { env, cleanup } = withBots({ maint: fx.cfg as Record<string, unknown> });
    try {
      let err: Error | undefined;
      try {
        loadBotConfig('maint', env);
      } catch (e) {
        err = e as Error;
      }
      assert.ok(err, `${fx.label}: expected a throw`);
      assert.match(err!.message, fx.field, `${fx.label}: error must name the field`);
      if (fx.message) assert.match(err!.message, fx.message, fx.label);
      assert.ok(!/tok-/.test(err!.message), `${fx.label}: no token value in errors`);
    } finally {
      cleanup();
    }
  }
});

test('the run + singleFlight combination loads but warns (§12)', () => {
  const cfg = JSON.parse(JSON.stringify(OK_CFG)) as { schedule: { tasks: { onMiss?: string }[] } };
  cfg.schedule.tasks[0]!.onMiss = 'run';
  const { env, cleanup } = withBots({ maint: cfg });
  try {
    const loaded = loadBotConfig('maint', env);
    assert.equal(loaded.tasks[0]!.onMiss, 'run');
    assert.ok(loaded.warnings.some((w) => w.includes('onMiss')), 'the stacking warning must be present');
  } finally {
    cleanup();
  }
});

test('alias rules: file name is the alias; invalid alias refused before any file IO', () => {
  assert.throws(() => botConfigPath('Bad_Alias'), /bot alias must match/);
  assert.throws(() => loadBotConfig('../escape'), /bot alias must match/);
});

test('credentials: 0600 ok; group-readable refused; missing alias named; bad shape named', () => {
  // 0600 + entry present
  {
    const { env, cleanup } = withBots({}, { json: { maint: { api: 'tok-bot-maint-1' } } });
    try {
      const pair = readBotCredentials('maint', env);
      assert.equal(pair.api, 'tok-bot-maint-1');
    } finally {
      cleanup();
    }
  }
  // group-readable refused
  {
    const { env, cleanup } = withBots({}, { json: { maint: { api: 'tok-bot-maint-1' } }, mode: 0o644 });
    try {
      assert.throws(() => readBotCredentials('maint', env), /readable by group or others.*chmod 600/s);
    } finally {
      cleanup();
    }
  }
  // missing alias named with the file
  {
    const { env, cleanup } = withBots({}, { json: { other: { api: 'tok-x' } } });
    try {
      assert.throws(() => readBotCredentials('maint', env), /no entry for alias 'maint'/);
    } finally {
      cleanup();
    }
  }
  // unknown key inside the entry
  {
    const { env, cleanup } = withBots({}, { json: { maint: { token: 'tok-bot-maint-1' } } });
    try {
      assert.throws(() => readBotCredentials('maint', env), /unknown key 'token'.*did you mean 'api'/);
    } finally {
      cleanup();
    }
  }
});

test('two-copy agreement: drifted copies are reported, agreeing copies resolve to bot-<alias>', () => {
  // The expected owner id form is the B0-1 decision, asserted here so a change in the id form
  // fails loudly next to the check that depends on it.
  assert.equal(botOwnerId('maint'), 'bot-maint');
  // Registered as the right owner.
  assert.equal(registeredOwnerForToken('tok-1', 'tok-1:bot-maint,tok-2:alice'), 'bot-maint');
  // Not registered at all.
  assert.equal(registeredOwnerForToken('tok-9', 'tok-1:bot-maint'), null);
  // Registered but for someone else (drift after rotation).
  assert.equal(registeredOwnerForToken('tok-1', 'tok-1:alice'), 'alice');
  // Empty/absent env.
  assert.equal(registeredOwnerForToken('tok-1', undefined), null);
  assert.equal(registeredOwnerForToken('tok-1', ''), null);
});
