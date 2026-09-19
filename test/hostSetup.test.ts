/**
 * `mercury host setup` (docs/host-installer.md M3) — the configuration wizard.
 *
 * The M3 gate: an answers file fed to `--non-interactive` produces a byte-identical
 * `mercury.env` to the interactive path with the same answers; an invalid answer, or a
 * variable name not in `docs/configuration.md`, is rejected before anything is written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import {
  parseHostSetupArgs,
  validateAnswer,
  validateAnswers,
  renderEnv,
  envFilePath,
  writeEnvFile,
  redactedSummary,
  defaultAnswers,
  readAnswersFile,
  runHostSetup,
  generateAdminToken,
  WIZARD_VARIABLES,
  KNOWN_HARNESSES,
  type HostSetupAnswers,
} from '../src/host/setup.ts';

const ROOT = resolve(import.meta.dirname, '..');

function answers(over: Partial<HostSetupAnswers> = {}): HostSetupAnswers {
  return {
    hostName: 'host-a',
    dataDir: '/var/lib/mercury',
    workspaceDir: '/var/lib/mercury/workspaces',
    retentionDays: 7,
    adminToken: '',
    atlasEnabled: false,
    atlasUrl: '',
    atlasToken: '',
    atlasProject: '',
    harnesses: ['primeagent', 'hermes'],
    ...over,
  };
}

// ---------- argument parsing ----------

test('parseHostSetupArgs: defaults and flags', () => {
  const o = parseHostSetupArgs([]);
  assert.equal(o.nonInteractive, false);
  assert.equal(o.dryRun, false);
  assert.equal(o.answersFile, undefined);
  assert.equal(o.yes, false);
  const o2 = parseHostSetupArgs(['--non-interactive', '--dry-run', '--answers', 'a.json', '--yes']);
  assert.equal(o2.nonInteractive, true);
  assert.equal(o2.dryRun, true);
  assert.equal(o2.answersFile, 'a.json');
  assert.equal(o2.yes, true);
});

test('parseHostSetupArgs: unknown flag is an error', () => {
  assert.throws(() => parseHostSetupArgs(['--bogus']), /unknown flag/);
});

test('parseHostSetupArgs: --answers requires --non-interactive', () => {
  assert.throws(() => parseHostSetupArgs(['--answers', 'a.json']), /--answers requires --non-interactive/);
});

// ---------- validation ----------

test('validateAnswer: each field validates', () => {
  assert.equal(validateAnswer('hostName', ''), 'host name must not be empty');
  assert.equal(validateAnswer('hostName', 'host-a'), null);
  assert.equal(validateAnswer('retentionDays', 0), 'retention must be a positive number of days');
  assert.equal(validateAnswer('retentionDays', 7), null);
  assert.ok(validateAnswer('harnesses', ['bogus'])!.includes('unknown harness'));
  assert.equal(validateAnswer('harnesses', ['primeagent']), null);
});

test('validateAnswers: Atlas on requires URL, token and project', () => {
  const bad = answers({ atlasEnabled: true, atlasUrl: '', atlasToken: '', atlasProject: '' });
  const errors = validateAnswers(bad);
  assert.ok(errors.some((e) => e.includes('atlasUrl: required')));
  assert.ok(errors.some((e) => e.includes('atlasToken: required')));
  assert.ok(errors.some((e) => e.includes('atlasProject: required')));
  const good = answers({ atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasToken: 't', atlasProject: 'p' });
  assert.deepEqual(validateAnswers(good), []);
});

// ---------- rendering ----------

test('renderEnv: writes the resolved admin token and refuses an unresolved one (#648)', () => {
  assert.throws(() => renderEnv(answers({ adminToken: '  ' })), /resolve before rendering/);
  const env = renderEnv(answers({ adminToken: 'tok-admin-123' }));
  assert.ok(env.includes('MERCURY_ADMIN_TOKEN=tok-admin-123'));
});

test('generateAdminToken: 64 hex chars, random across calls', () => {
  const a = generateAdminToken();
  const b = generateAdminToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('runHostSetup generates MERCURY_ADMIN_TOKEN and prints it exactly once (#648)', async () => {
  const dir = tempDir('setup-token-');
  const out: string[] = [];
  const code = await runHostSetup([], {
    out: (s) => out.push(s),
    err: () => {},
    question: async () => '',
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const text = out.join('');
  const tokens = text.match(/host API token:\s+([0-9a-f]{64})/) ?? [];
  assert.ok(tokens[1], 'the generated token must be shown once in the output');
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes(`MERCURY_ADMIN_TOKEN=${tokens[1]}`), 'the written file must carry the shown token');
  // Shown once: the token value appears in exactly one output line (the marked block).
  const occurrences = out.filter((l) => l.includes(tokens[1]!)).length;
  assert.equal(occurrences, 1);
});

test('interactive re-run masks the existing token in the prompt (#648 review)', async () => {
  const dir = tempDir('setup-mask-');
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'no', 'primeagent'];
  let i = 0;
  const code = await runHostSetup([], { out: () => {}, err: () => {}, question: async () => qs[i++] ?? '' }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const first = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.ok(first);
  // Re-run interactively, answering everything by default (enter). Capture the questions.
  const questions: string[] = [];
  const out: string[] = [];
  const code2 = await runHostSetup(['--yes'], {
    out: (s) => out.push(s), err: () => {},
    question: async (q) => { questions.push(q); return ''; },
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code2, 0);
  const adminQ = questions.find((q) => q.startsWith('Admin/API token'));
  assert.ok(adminQ, 'the admin token question must be asked');
  assert.ok(!adminQ!.includes(first!), 'the prompt must not echo the live token');
  assert.ok(adminQ!.includes('<set, 64 chars>'), adminQ);
  const second = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.equal(second, first, 'enter must keep the existing token');
  // And the token must not be re-printed in the output (it was shown only on first generation).
  assert.ok(!out.join('').includes(first!), 'the token value must not be printed again on re-run');
});

test('re-run preserves the existing MERCURY_ADMIN_TOKEN (no silent rotation, #648)', async () => {
  const dir = tempDir('setup-rotate-');
  // Question order: hostName, dataDir, workspaceDir, retention, adminToken, Atlas?, harnesses.
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'no', 'primeagent'];
  let i = 0;
  const code = await runHostSetup([], { out: () => {}, err: () => {}, question: async () => qs[i++] ?? '' }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const first = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.ok(first, 'the first run must write a generated token');
  const code2 = await runHostSetup(['--non-interactive', '--yes'], { out: () => {}, err: () => {} }, { XDG_CONFIG_HOME: dir });
  assert.equal(code2, 0);
  const second = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.equal(second, first, 'a --yes re-run must preserve the existing token by default');
});

test('renderEnv: maps answers to documented MERCURY_* lines', () => {
  const env = renderEnv(answers({ adminToken: 'tok-admin-123' }));
  assert.ok(env.includes('MERCURY_ATLAS_HOST_ID=host-a'));
  assert.ok(env.includes('MERCURY_DB=/var/lib/mercury/mercury.db'));
  assert.ok(env.includes('MERCURY_WORKSPACE_BASE=/var/lib/mercury/workspaces'));
  assert.ok(env.includes('MERCURY_WORKSPACE_RETENTION_MS=604800000'));
  assert.ok(env.includes('MERCURY_ADMIN_TOKEN=tok-admin-123'));
  assert.ok(env.includes('MERCURY_HARNESSES=primeagent,hermes'));
  // Fleet is pull, not push (issue #645): the wizard emits no Fleet URL and no host token.
  assert.ok(!env.includes('MERCURY_FLEET_URL'));
  assert.ok(!env.includes('MERCURY_HOST_TOKEN'));
  assert.ok(env.includes('MERCURY_DEFAULT_AGENT=primeagent'));
  // Atlas off: no Atlas lines.
  assert.ok(!env.includes('MERCURY_ATLAS_URL'));
});

test('renderEnv: Atlas on adds the Atlas lines', () => {
  const env = renderEnv(answers({ adminToken: 'tok-admin-123', atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasToken: 'at', atlasProject: 'proj' }));
  assert.ok(env.includes('MERCURY_ATLAS_URL=https://atlas.example.com'));
  assert.ok(env.includes('MERCURY_ATLAS_TOKEN=at'));
  assert.ok(env.includes('MERCURY_ATLAS_PROJECT=proj'));
});

test('WIZARD_VARIABLES: every emitted name is documented AND read by the host (design decision 10, issue #645)', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8');
  const configSrc = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
  for (const name of WIZARD_VARIABLES) {
    assert.ok(doc.includes(name), `${name} must be documented in docs/configuration.md`);
    // The first build documented names the host never read (issue #645). A name the
    // wizard emits must appear in src/config.ts (parsed or defaulted there), so the
    // wizard cannot produce a config the host silently ignores.
    assert.ok(configSrc.includes(`env.${name}`), `${name} must be read in src/config.ts`);
  }
});

// ---------- the M3 gate: interactive and answers-file agree ----------

test('M3 gate: interactive and answers-file produce byte-identical mercury.env', async () => {
  const dir = tempDir('setup-gate-');
  const answersFile = join(dir, 'answers.json');
  const a = answers({ adminToken: 'tok-admin-gate-1', atlasToken: 'tok-gate-42', atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasProject: 'proj' });
  writeFileSync(answersFile, JSON.stringify(a));

  // Interactive path: inject the question function.
  const interactiveEnv = await new Promise<string>((res, rej) => {
    const qs = [
      a.hostName, a.dataDir, a.workspaceDir, String(a.retentionDays), a.adminToken,
      'yes', // Atlas
      a.atlasUrl, a.atlasToken, a.atlasProject,
      a.harnesses.join(','),
    ];
    let i = 0;
    void runHostSetup([], {
      out: () => {},
      err: () => {},
      question: async () => qs[i++] ?? '',
    }, { XDG_CONFIG_HOME: dir }).then((code) => {
      if (code !== 0) return rej(new Error(`interactive exit ${code}`));
      res(readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8'));
    });
  });

  // Non-interactive path with the same answers.
  const niEnv = await new Promise<string>((res, rej) => {
    void runHostSetup(['--non-interactive', '--yes', '--answers', answersFile], {
      out: () => {},
      err: () => {},
    }, { XDG_CONFIG_HOME: dir }).then((code) => {
      if (code !== 0) return rej(new Error(`non-interactive exit ${code}`));
      res(readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8'));
    });
  });

  assert.equal(interactiveEnv, niEnv, 'interactive and answers-file must produce byte-identical mercury.env');
});

// ---------- the CLI surface ----------

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

test('host setup --non-interactive writes mercury.env with mode 0600', async () => {
  const dir = tempDir('setup-cli-');
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive'], {
    XDG_CONFIG_HOME: dir,
    MERCURY_ATLAS_URL: 'https://atlas.example.com',
    MERCURY_ATLAS_TOKEN: 'tok-cli-1',
    MERCURY_ATLAS_PROJECT: 'proj',
  });
  assert.equal(code, 0, stderr);
  const path = join(dir, 'mercury', 'mercury.env');
  assert.ok(existsSync(path), 'mercury.env must exist');
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `mercury.env must be 0600, got ${mode.toString(8)}`);
  const content = readFileSync(path, 'utf8');
  assert.ok(content.includes('MERCURY_ATLAS_TOKEN=tok-cli-1'));
  assert.ok(!content.includes('MERCURY_HOST_TOKEN'), 'the wizard emits no host token (issue #645)');
  assert.ok(!content.includes('MERCURY_FLEET_URL'), 'the wizard emits no Fleet URL (issue #645)');
});

test('host setup rejects an invalid answer before writing anything', async () => {
  const dir = tempDir('setup-invalid-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ harnesses: ['bogus'] })));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', answersFile], {
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown harness'));
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')), 'nothing must be written on invalid answers');
});

test('host setup rejects an unknown flag', async () => {
  const { code, stderr } = await cli(['host', 'setup', '--bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('host setup --dry-run touches nothing', async () => {
  const dir = tempDir('setup-dryrun-');
  const { code, stdout } = await cli(['host', 'setup', '--non-interactive', '--dry-run'], {
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Would write'));
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')), '--dry-run must not write');
});

test('redactedSummary: secrets show presence and length only', () => {
  const s = redactedSummary(answers({ atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasProject: 'proj', atlasToken: 'tok-secret-123' }));
  assert.ok(s.includes('MERCURY_ATLAS_TOKEN=<set, 14 chars>'));
  assert.ok(!s.includes('tok-secret-123'), 'the token value must never appear');
});

test('defaultAnswers: harnesses filter to known ids', () => {
  const a = defaultAnswers({ MERCURY_HARNESSES: 'primeagent,bogus,claude' } as NodeJS.ProcessEnv);
  assert.deepEqual(a.harnesses, ['primeagent', 'claude']);
});

test('retentionDays 0 is rejected, not silently defaulted', async () => {
  const dir = tempDir('setup-ret0-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ retentionDays: 0 })));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', answersFile], {
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('retention must be a positive number of days'));
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')));
});

test('a missing answers file exits cleanly with a message', async () => {
  const dir = tempDir('setup-missing-');
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', join(dir, 'nope.json')], {
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('cannot read answers file'));
});

test('re-run on a configured host refuses to overwrite without --yes (M5 gate)', async () => {
  const dir = tempDir('setup-rerun-');
  const cfg = join(dir, 'cfg');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_ATLAS_HOST_ID=old\n');
  const { code, stdout } = await cli(['host', 'setup', '--non-interactive'], {
    XDG_CONFIG_HOME: cfg,
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes('already exists'));
  // The file is untouched.
  const content = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
  assert.ok(content.includes('MERCURY_ATLAS_HOST_ID=old'));
});
