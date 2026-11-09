// Bot config + credentials validation fixtures (B0-5, #733; docs/dispatcher-bot-design.md §4.1,
// §4.2, §12). Every malformed config in the fixture set must be refused WITH A NAMED FIELD --
// a validation error that does not name its field sends the operator hunting through a JSON tree
// at 03:00 for the one key the validator already knows is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.ts';
import { loadBotConfig, botConfigPath, validateBotTemplates } from '../src/host/bots/config.ts';
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
    // Found by the B4 §14 review (#915): three §12 fields had no negative fixture.
    { label: 'description must be a string', cfg: { ...OK_CFG, description: 42 }, field: /description/, message: /must be a string/ },
    { label: 'template must be a JSON object', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: 'do it' },
    ] } }, field: /schedule\.tasks\[0\]\.template/, message: /JSON object/ },
    { label: 'singleFlight must be a boolean', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, singleFlight: 'yes' },
    ] } }, field: /schedule\.tasks\[0\]\.singleFlight/, message: /boolean/ },
    { label: 'bad api url', cfg: { ...OK_CFG, api: { url: 'ftp://x' } }, field: /api\.url/, message: /http/ },
    { label: 'fake http scheme', cfg: { ...OK_CFG, api: { url: 'httpx://x' } }, field: /api\.url/, message: /http/ },
    { label: 'bad timeout', cfg: { ...OK_CFG, api: { url: 'http://x', timeoutMs: 0 } }, field: /api\.timeoutMs/, message: /positive integer/ },
    // #826: select shape errors come BEFORE the reserved refusal.
    { label: 'select with a malformed candidate is refused with the shape error first', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', candidates: [{ agent: 'hermes' }] } },
    ] } }, field: /select\.candidates\[0\]\.describe/, message: /non-empty/ },
    { label: 'select via not laya', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'brain', candidates: [{ agent: 'hermes', describe: 'x' }] } },
    ] } }, field: /select\.via/, message: /must be 'laya'/ },
    { label: 'select bad mode', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', mode: 'yolo', candidates: [{ agent: 'hermes', describe: 'x' }] } },
    ] } }, field: /select\.mode/, message: /shadow, enforce/ },
    { label: 'select enforce without minConfidence', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', mode: 'enforce', candidates: [{ agent: 'hermes', describe: 'x' }] } },
    ] } }, field: /select\.minConfidence/, message: /required when mode is enforce/ },
    { label: 'select minConfidence out of range', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', minConfidence: 1, candidates: [{ agent: 'hermes', describe: 'x' }] } },
    ] } }, field: /select\.minConfidence/, message: /\(0, 1\)/ },
    { label: 'select empty candidates', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', candidates: [] } },
    ] } }, field: /select\.candidates/, message: /non-empty/ },
    { label: 'select too many candidates', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', candidates: Array.from({ length: 13 }, (_, i) => ({ agent: 'hermes', describe: `c${i}` })) } },
    ] } }, field: /select\.candidates/, message: /at most 12/ },
    { label: 'select candidate with unknown key', cfg: { schedule: { tasks: [
      { name: 'a', cron: '* * * * *', template: { task: 'x' }, select: { via: 'laya', candidates: [{ agent: 'hermes', describe: 'x', credential: 'tok-9' }] } },
    ] } }, field: /select\.candidates\[0\]/, message: /unknown key 'credential'/ },
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

test('select: a WELL-FORMED block is refused with the reserved message (#826, fails on base)', () => {
  const cfg = JSON.parse(JSON.stringify(OK_CFG)) as Record<string, unknown>;
  (cfg.schedule as Record<string, unknown>).tasks = [{
    name: 'a', cron: '* * * * *', template: { task: 'x' },
    select: {
      via: 'laya', mode: 'shadow', minConfidence: 0.8,
      candidates: [
        { agent: 'claude', model: 'opus', describe: 'hard multi-file changes' },
        { agent: 'hermes', describe: 'routine fixes' },
      ],
    },
  }];
  const { env, cleanup } = withBots({ maint: cfg });
  try {
    let err: Error | undefined;
    try {
      loadBotConfig('maint', env);
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err, 'a well-formed select is still refused before L1');
    assert.match(err!.message, /reserved: select is not supported before L1/);
  } finally {
    cleanup();
  }
});

test('select: an UNKOWN top-level key still refuses as unknown, not reserved (#826)', () => {
  // Guards the shape-first ordering: a typo in the select block must not read as the reserved
  // refusal (which would tell the operator to wait for L1 instead of fixing the key).
  const cfg = JSON.parse(JSON.stringify(OK_CFG)) as Record<string, unknown>;
  (cfg.schedule as Record<string, unknown>).tasks = [{
    name: 'a', cron: '* * * * *', template: { task: 'x' },
    select: { via: 'laya', candiates: [{ agent: 'hermes', describe: 'x' }] },
  }];
  const { env, cleanup } = withBots({ maint: cfg });
  try {
    assert.throws(() => loadBotConfig('maint', env), /unknown key 'candiates'/);
  } finally {
    cleanup();
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
  // whitespace-padded token value: named at the field, not misread as drift later
  {
    const { env, cleanup } = withBots({}, { json: { maint: { api: ' tok-bot-maint-1 ' } } });
    try {
      assert.throws(() => readBotCredentials('maint', env), /entry 'maint\.api' has leading or trailing whitespace/);
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
  // Whitespace around the halves must not read as unregistered (loadConfig trims both halves).
  assert.equal(registeredOwnerForToken('tok-1', ' tok-1 : bot-maint , tok-2:alice'), 'bot-maint');
  // Not registered at all.
  assert.equal(registeredOwnerForToken('tok-9', 'tok-1:bot-maint'), null);
  // Registered but for someone else (drift after rotation).
  assert.equal(registeredOwnerForToken('tok-1', 'tok-1:alice'), 'alice');
  // Empty/absent env.
  assert.equal(registeredOwnerForToken('tok-1', undefined), null);
  assert.equal(registeredOwnerForToken('tok-1', ''), null);
  // Malformed env is NOT skipped: validate runs before loadConfig, so the same safe, index-based
  // error (no token echoed) must surface here.
  assert.throws(() => registeredOwnerForToken('tok-1', 'tok-1'), /entry 0 must be exactly 'token:owner'.*no colon/);
  assert.throws(() => registeredOwnerForToken('tok-1', 'tok-1:'), /entry 0 must be exactly 'token:owner'.*empty owner half/);
  assert.throws(() => registeredOwnerForToken('tok-1', 'a:b:c'), /entry 0 must be exactly 'token:owner'.*2 colons/);
});


// -- Task template validation (A0-5, #989, acceptance 3) -------------------------------
//
// `host bot validate` runs every task template through the SAME validateCreateRequest
// POST /api/runs uses, as the scheduler will POST it: resolved at the task's next scheduled
// fire, with the dispatch-time constraint additions. deploy/nightly-bot.json.example must
// still pass; a template without a repository must fail it (the #785 gap, closed for bots).

const EXAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'nightly-bot.json.example');

function templateBot(template: Record<string, unknown>, cron = '*/20 * * * *'): Record<string, unknown> {
  return {
    schedule: {
      tasks: [
        { name: 'the-task', cron, tz: 'UTC', singleFlight: true, onMiss: 'skip', template },
      ],
    },
  };
}

test('acceptance 3: the shipped nightly example still passes template validation', () => {
  const { env, cleanup } = withBots({ nightly: JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) });
  try {
    const cfg = loadBotConfig('nightly', env);
    const result = validateBotTemplates(cfg);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.ok, ['nightly-e2e', 'nightly-next', 'nightly-report']);
  } finally {
    cleanup();
  }
});

test('acceptance 3: a bot template without a repository now fails it', () => {
  const { env, cleanup } = withBots({ norepo: templateBot({ task: 'do the thing', constraints: { maxDurationMs: 3600000 } }) });
  try {
    const result = validateBotTemplates(loadBotConfig('norepo', env));
    assert.equal(result.ok.length, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0]!, /schedule\.tasks\[the-task\]\.template/);
    assert.match(result.findings[0]!, /must name a repository \(url or localPath\); a Run without one fails at workspace setup \(#785\)/);
  } finally {
    cleanup();
  }
});

test('an empty repository object fails: it is the create surface\'s "no repository" form, not a checkout', () => {
  const { env, cleanup } = withBots({ emptyrepo: templateBot({ task: 'do the thing', repository: {} }) });
  try {
    const result = validateBotTemplates(loadBotConfig('emptyrepo', env));
    assert.match(result.findings[0]!, /must name a repository with a url or localPath/);
  } finally {
    cleanup();
  }
});

test('an unknown create-request key in a template fails with a suggestion', () => {
  const { env, cleanup } = withBots({ badkey: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, consraints: { maxDurationMs: 3600000 } }) });
  try {
    const result = validateBotTemplates(loadBotConfig('badkey', env));
    assert.match(result.findings[0]!, /unknown key "consraints" \(did you mean 'constraints'\?\)/);
  } finally {
    cleanup();
  }
});

test('an invalid constraint in a template fails through the shared validator', () => {
  const { env, cleanup } = withBots({ badconstraint: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, constraints: { maxDurationMs: -1 } }) });
  try {
    const result = validateBotTemplates(loadBotConfig('badconstraint', env));
    assert.match(result.findings[0]!, /constraint maxDurationMs must be >= 0/);
  } finally {
    cleanup();
  }
});

test('a notAfter already in the past fails with the creation-time message', () => {
  const { env, cleanup } = withBots({ pastdeadline: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, constraints: { notAfter: '2020-01-01T00:00:00Z' } }) });
  try {
    const result = validateBotTemplates(loadBotConfig('pastdeadline', env));
    assert.match(result.findings[0]!, /constraint notAfter must be in the future/);
  } finally {
    cleanup();
  }
});

test('a deadline between now and the fire\'s own instant fails: it would 400 on every fire', () => {
  // The deadline is the fire's OWN wall-clock minute: in the future at creation (the shared
  // validator passes it) yet not after the first dispatch, where the server refuses a notAfter
  // that predates the creation instant. That is the #785 class one level down: a template that
  // 400s on every fire. The clock is simulated (midday) and the schedule fires daily at 04:00,
  // so the next fire is a fixed ~16h ahead on the REAL calendar and the deadline's date cannot
  // roll under the real clock: the old fixture derived notAfterAt from now+1min on a */20 cron,
  // and in the day's last cron window (23:40-24:00) the fire's date rolled to the next day
  // while the minute did not, so the check passed and the test failed (23:41 UTC).
  const simulatedNow = new Date();
  simulatedNow.setUTCHours(12, 0, 0, 0);
  const { env, cleanup } = withBots({ earlydeadline: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, notAfterAt: '04:00' }, '0 4 * * *') });
  try {
    const result = validateBotTemplates(loadBotConfig('earlydeadline', env), simulatedNow.getTime());
    assert.equal(result.ok.length, 0);
    assert.match(result.findings[0]!, /notAfter .+ is in the past at the task's fire time/);
  } finally {
    cleanup();
  }
});

test('a template that cannot be resolved is a finding, and later tasks are still checked (Copilot review of this PR)', () => {
  // notAfterAt: 'tomorrow' passes loadBotConfig (the template is untyped) but resolveTemplate
  // throws on its 'HH:MM' check. The scheduler records that failure per fire and keeps going,
  // so validate must do the same: a task-qualified finding, never an abort that skips the
  // remaining tasks and the command's own credential checks.
  const cfg = {
    schedule: {
      tasks: [
        { name: 'broken', cron: '*/20 * * * *', tz: 'UTC', singleFlight: true, onMiss: 'skip',
          template: { task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, notAfterAt: 'tomorrow' } },
        { name: 'fine', cron: '*/20 * * * *', tz: 'UTC', singleFlight: true, onMiss: 'skip',
          template: { task: 'do the other thing', repository: { url: 'https://github.com/aywengo/mercury.git' } } },
      ],
    },
  };
  const { env, cleanup } = withBots({ badresolve: cfg });
  try {
    const result = validateBotTemplates(loadBotConfig('badresolve', env));
    assert.deepEqual(result.ok, ['fine']);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0]!, /schedule\.tasks\[broken\]\.template: notAfterAt must be 'HH:MM', got 'tomorrow'/);
  } finally {
    cleanup();
  }
});

test('a fleet-via template may name the routing fields host and labels (Copilot review of this PR)', () => {
  // api.via: "fleet" (fleet-bots-design.md section 4): the fleet submit handler consumes
  // host/labels before dispatch and strips them from the child payload, so they are NOT
  // create-request fields and must not fail the shared check. A malformed value is a finding,
  // and on the host path the same fields remain unknown-key refusals.
  const fleetBot = (template: Record<string, unknown>) => ({
    api: { url: 'http://127.0.0.1:4100', via: 'fleet' },
    schedule: { tasks: [{ name: 'the-task', cron: '*/20 * * * *', tz: 'UTC', singleFlight: true, onMiss: 'skip', template }] },
  });
  const { env, cleanup } = withBots({
    fleetok: fleetBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, host: 'worker-2', labels: { pool: 'gpu' } }),
    fleethost: fleetBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, host: 42 }),
    fleetlabels: fleetBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, labels: 'gpu' }),
    hostpath: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, host: 'worker-2' }),
  }, { json: { fleetok: { api: 'tapi-1', fleet: 'tfleet-1' }, fleethost: { api: 'tapi-2', fleet: 'tfleet-2' }, fleetlabels: { api: 'tapi-3', fleet: 'tfleet-3' } } });
  try {
    const ok = validateBotTemplates(loadBotConfig('fleetok', env));
    assert.deepEqual(ok.findings, []);
    assert.deepEqual(ok.ok, ['the-task']);
    const host = validateBotTemplates(loadBotConfig('fleethost', env));
    assert.equal(host.findings.length, 1);
    assert.match(host.findings[0]!, /host must be a non-empty string when present/);
    const labels = validateBotTemplates(loadBotConfig('fleetlabels', env));
    assert.equal(labels.findings.length, 1);
    assert.match(labels.findings[0]!, /labels must be an object of string values when present/);
    // The host path posts the body as-is to /api/runs: the routing field is an unknown key there.
    const hp = validateBotTemplates(loadBotConfig('hostpath', env));
    assert.equal(hp.findings.length, 1);
    assert.match(hp.findings[0]!, /unknown key "host"/);
  } finally {
    cleanup();
  }
});

test('a schedule that never fires within 24h warns, not refuses', () => {
  const { env, cleanup } = withBots({ never: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, notAfterAt: '06:00' }, '0 0 31 2 *') });
  try {
    const result = validateBotTemplates(loadBotConfig('never', env));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.ok, ['the-task']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /no fire within 24h; notAfterAt not checked/);
  } finally {
    cleanup();
  }
});

test('a server-stamped field in a template fails with the route message', () => {
  const { env, cleanup } = withBots({ stamped: templateBot({ task: 'do the thing', repository: { url: 'https://github.com/aywengo/mercury.git' }, ownerId: 'alice' }) });
  try {
    const result = validateBotTemplates(loadBotConfig('stamped', env));
    assert.match(result.findings[0]!, /ownerId is set by the server and cannot be supplied in a request body/);
  } finally {
    cleanup();
  }
});
