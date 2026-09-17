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
    fleetUrl: 'https://fleet.example.com',
    hostToken: 'tok-secret-123',
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
  const o2 = parseHostSetupArgs(['--non-interactive', '--dry-run', '--answers', 'a.json']);
  assert.equal(o2.nonInteractive, true);
  assert.equal(o2.dryRun, true);
  assert.equal(o2.answersFile, 'a.json');
});

test('parseHostSetupArgs: unknown flag is an error', () => {
  assert.throws(() => parseHostSetupArgs(['--bogus']), /unknown flag/);
});

// ---------- validation ----------

test('validateAnswer: each field validates', () => {
  assert.equal(validateAnswer('hostName', ''), 'host name must not be empty');
  assert.equal(validateAnswer('hostName', 'host-a'), null);
  assert.equal(validateAnswer('retentionDays', 0), 'retention must be a positive number of days');
  assert.equal(validateAnswer('retentionDays', 7), null);
  assert.equal(validateAnswer('fleetUrl', 'not-a-url'), 'Fleet URL must start with http:// or https://');
  assert.equal(validateAnswer('fleetUrl', 'https://fleet.example.com'), null);
  assert.equal(validateAnswer('fleetUrl', ''), null);
  assert.equal(validateAnswer('hostToken', ''), 'host token must not be empty');
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

test('renderEnv: maps answers to documented MERCURY_* lines', () => {
  const env = renderEnv(answers());
  assert.ok(env.includes('MERCURY_ATLAS_HOST_ID=host-a'));
  assert.ok(env.includes('MERCURY_DB=/var/lib/mercury/mercury.db'));
  assert.ok(env.includes('MERCURY_WORKSPACE_BASE=/var/lib/mercury/workspaces'));
  assert.ok(env.includes('MERCURY_WORKSPACE_RETENTION_MS=604800000'));
  assert.ok(env.includes('MERCURY_FLEET_URL=https://fleet.example.com'));
  assert.ok(env.includes('MERCURY_HOST_TOKEN=tok-secret-123'));
  assert.ok(env.includes('MERCURY_HARNESSES=primeagent,hermes'));
  assert.ok(env.includes('MERCURY_DEFAULT_AGENT=primeagent'));
  // Atlas off: no Atlas lines.
  assert.ok(!env.includes('MERCURY_ATLAS_URL'));
});

test('renderEnv: Atlas on adds the Atlas lines', () => {
  const env = renderEnv(answers({ atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasToken: 'at', atlasProject: 'proj' }));
  assert.ok(env.includes('MERCURY_ATLAS_URL=https://atlas.example.com'));
  assert.ok(env.includes('MERCURY_ATLAS_TOKEN=at'));
  assert.ok(env.includes('MERCURY_ATLAS_PROJECT=proj'));
});

test('WIZARD_VARIABLES: every emitted name exists in docs/configuration.md (design decision 10)', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8');
  for (const name of WIZARD_VARIABLES) {
    assert.ok(doc.includes(name), `${name} must be documented in docs/configuration.md`);
  }
});

// ---------- the M3 gate: interactive and answers-file agree ----------

test('M3 gate: interactive and answers-file produce byte-identical mercury.env', async () => {
  const dir = tempDir('setup-gate-');
  const answersFile = join(dir, 'answers.json');
  const a = answers({ hostToken: 'tok-gate-42' });
  writeFileSync(answersFile, JSON.stringify(a));

  // Interactive path: inject the question function.
  const interactiveEnv = await new Promise<string>((res, rej) => {
    const qs = [
      a.hostName, a.dataDir, a.workspaceDir, String(a.retentionDays), a.fleetUrl, a.hostToken,
      'no', // Atlas
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
    void runHostSetup(['--non-interactive', '--answers', answersFile], {
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
    MERCURY_HOST_TOKEN: 'tok-cli-1',
    MERCURY_FLEET_URL: 'https://fleet.example.com',
  });
  assert.equal(code, 0, stderr);
  const path = join(dir, 'mercury', 'mercury.env');
  assert.ok(existsSync(path), 'mercury.env must exist');
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `mercury.env must be 0600, got ${mode.toString(8)}`);
  const content = readFileSync(path, 'utf8');
  assert.ok(content.includes('MERCURY_HOST_TOKEN=tok-cli-1'));
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
    MERCURY_HOST_TOKEN: 'tok-dry-1',
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Would write'));
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')), '--dry-run must not write');
});

test('redactedSummary: token shows presence and length only', () => {
  const s = redactedSummary(answers({ hostToken: 'tok-secret-123' }));
  assert.ok(s.includes('MERCURY_HOST_TOKEN=<set, 14 chars>'));
  assert.ok(!s.includes('tok-secret-123'), 'the token value must never appear');
});

test('defaultAnswers: harnesses filter to known ids', () => {
  const a = defaultAnswers({ MERCURY_HARNESSES: 'primeagent,bogus,claude' } as NodeJS.ProcessEnv);
  assert.deepEqual(a.harnesses, ['primeagent', 'claude']);
});
