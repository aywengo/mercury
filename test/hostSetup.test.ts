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
import { existsSync, mkdirSync, chmodSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import { startFakeLaya, validPick } from './support/fakeLaya.ts';
import {
  parseHostSetupArgs,
  envDiff,
  validateAnswer,
  validateAnswers,
  renderEnv,
  envFilePath,
  writeEnvFile,
  redactedSummary,
  defaultAnswers,
  layaCollisionEvidence,
  readAnswersFile,
  registeredLayaOwner,
  runHostSetup,
  generateAdminToken,
  sidecarExec,
  WIZARD_VARIABLES,
  KNOWN_HARNESSES,
  type HostSetupAnswers,
} from '../src/host/setup.ts';
import { isWizardManagedLayaDefault } from '../src/laya/layaUrl.ts';
import {
  DEFAULT_PYTHON_CANDIDATES,
  detectPython,
  discoverVersionedPythons,
  ensureLayaCredentials,
  LAYA_SERVE_PIN,
  layaStepActions,
  parsePythonVersion,
  planLayaSidecar,
  renderLayaLaunchdPlist,
  renderLayaSystemdUnit,
} from '../src/host/layaSidecar.ts';
import type { HarnessProbeResult } from '../src/host/probe.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** Healthy stub harness binaries: the wizard's probe spawns the real cmd when no probe
 *  is injected, so tests that exercise the default path point MERCURY_*_CMD at stubs
 *  that report a healthy version — the suite must not depend on the runner's
 *  harness inventory (CI has none installed). */
const stubDir = tempDir('setup-probe-stubs-');
for (const [name, version] of [
  ['prime-agent', '9.9.9'],
  ['hermes', '9.9.9'],
  ['claude', '9.9.9'],
] as const) {
  writeFileSync(join(stubDir, name), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
}
function probeStubEnv(): NodeJS.ProcessEnv {
  return {
    MERCURY_PRIMEAGENT_CMD: join(stubDir, 'prime-agent'),
    MERCURY_HERMES_CMD: join(stubDir, 'hermes'),
    MERCURY_CLAUDE_CMD: join(stubDir, 'claude'),
  };
}

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
    bindHost: '',
    harnesses: ['primeagent', 'hermes'],
    layaEnabled: false,
    layaUrl: '',
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
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
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

test('re-run preserves every hand-set variable the wizard does not own (#673)', async () => {
  const dir = tempDir('setup-preserve-all-');
  const cfg = join(dir, 'cfg');
  const first = await runHostSetup(['--non-interactive', '--yes'], {
    out: () => {}, err: () => {},
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg, MERCURY_HARNESSES: 'primeagent' });
  assert.equal(first, 0);
  const envPath = envFilePath({ XDG_CONFIG_HOME: cfg });
  // An operator hand-sets four variables the wizard never asks about (one explicitly empty).
  const withHandSet = readFileSync(envPath, 'utf8')
    + 'MERCURY_PORT=8080\nMERCURY_LOG_LEVEL=debug\nMERCURY_TLS_CERT=/tmp/c.pem\nMERCURY_PRIMEAGENT_ARGS=\n';
  writeFileSync(envPath, withHandSet);

  const out: string[] = [];
  const second = await runHostSetup(['--non-interactive', '--yes'], {
    out: (s) => out.push(s), err: () => {},
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg, MERCURY_HARNESSES: 'primeagent' });
  assert.equal(second, 0);
  const file = readFileSync(envPath, 'utf8');
  for (const line of ['MERCURY_PORT=8080', 'MERCURY_LOG_LEVEL=debug', 'MERCURY_TLS_CERT=/tmp/c.pem', 'MERCURY_PRIMEAGENT_ARGS=']) {
    assert.ok(file.includes(line), `${line} must survive the rewrite (empty values included): ${file}`);
  }
  // The summary names what is carried forward — names only, never values.
  const text = out.join('');
  assert.ok(text.includes('preserved (hand-set): MERCURY_LOG_LEVEL, MERCURY_PORT, MERCURY_PRIMEAGENT_ARGS, MERCURY_TLS_CERT'), text);
  assert.ok(!text.includes(':8080') && !text.includes('c.pem'), 'preserved values must not print');
});

test('re-run with a rotated token prints updated-not-shown, never the value (#676 round 1)', async () => {
  const dir = tempDir('setup-rerun-rotate-');
  const cfg = join(dir, 'cfg');
  const first = await runHostSetup(['--non-interactive', '--yes'], {
    out: () => {}, err: () => {},
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg, MERCURY_HARNESSES: 'primeagent' });
  assert.equal(first, 0);
  const oldToken = readFileSync(envFilePath({ XDG_CONFIG_HOME: cfg }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)![1];

  const out: string[] = [];
  const newToken = 'b'.repeat(64);
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', newToken, 'no', 'primeagent'];
  let i = 0;
  const second = await runHostSetup(['--yes'], {
    out: (s) => out.push(s), err: () => {},
    question: async () => qs[i++] ?? '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg });
  assert.equal(second, 0);
  const text = out.join('');
  assert.ok(text.includes('host API token:    updated (not shown'), text);
  assert.ok(!text.includes(oldToken) && !text.includes(newToken), 'neither token value may print');
  assert.ok(readFileSync(envFilePath({ XDG_CONFIG_HOME: cfg }), 'utf8').includes(`MERCURY_ADMIN_TOKEN=${newToken}`));
});

test('re-run with an existing token and a newly-set bind still prints the Fleet URL (#672)', async () => {
  // First run: loopback default (the block advises re-running with a bind address).
  const dir = tempDir('setup-rerun-bind-');
  const cfg = join(dir, 'cfg');
  const first = await runHostSetup(['--non-interactive', '--yes'], {
    out: () => {}, err: () => {},
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg, MERCURY_HARNESSES: 'primeagent' });
  assert.equal(first, 0);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: cfg }), 'utf8');
  const existingToken = file.match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)![1];

  // Re-run with --yes and a newly-set non-loopback bind: the token is preserved, so the
  // old generatedToken gate would have skipped the URL entirely (#672). The wizard must
  // still print the registration URL, and must NOT print a fresh token.
  const out: string[] = [];
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'no', 'primeagent', '0.0.0.0'];
  let i = 0;
  const second = await runHostSetup(['--yes'], {
    out: (s) => out.push(s), err: () => {},
    question: async () => qs[i++] ?? '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: cfg });
  assert.equal(second, 0);
  const text = out.join('');
  assert.ok(text.includes('host API base URL: http://<this-host>:'), `the URL must print on a re-run: ${text}`);
  assert.ok(text.includes('host API token:    unchanged'), `the token line must say unchanged: ${text}`);
  assert.ok(!text.includes(existingToken), 'the stored token must not be re-printed');
  assert.ok(readFileSync(envFilePath({ XDG_CONFIG_HOME: cfg }), 'utf8').includes('MERCURY_BIND_HOST=0.0.0.0'));
});

test('interactive re-run masks the existing token in the prompt (#648 review)', async () => {
  const dir = tempDir('setup-mask-');
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'no', 'primeagent'];
  let i = 0;
  // Hermetic probe: on a machine without the harnesses the real probe would reject the
  // answers, which is honest wizard behavior but not what this test is about (#648 review).
  // The stub commands make the real probe report all-ok on any machine.
  const code = await runHostSetup([], {
    out: () => {}, err: () => {}, question: async () => qs[i++] ?? '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const first = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.ok(first);
  // Re-run interactively, answering everything by default (enter). Capture the questions.
  const questions: string[] = [];
  const out: string[] = [];
  const code2 = await runHostSetup(['--yes'], {
    out: (s) => out.push(s), err: () => {},
    question: async (q) => { questions.push(q); return ''; },
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
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

test('the atlas token prompt masks an existing default and uses the muted secret channel (#649 §1)', async () => {
  const dir = tempDir('setup-atlas-mask-');
  // First run: Atlas on, token typed once (goes through the muted channel when available).
  const qs1 = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'yes', 'https://atlas.example.com', 'atlas-secret-1', 'proj', 'primeagent'];
  let i = 0;
  const secrets1: string[] = [];
  const code1 = await runHostSetup([], {
    out: () => {}, err: () => {},
    question: async () => qs1[i++] ?? '',
    secretQuestion: async (q: string) => { secrets1.push(q); return qs1[i++] ?? ''; },
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code1, 0);
  const first = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ATLAS_TOKEN=(.+)/)?.[1];
  assert.equal(first, 'atlas-secret-1');
  // The atlas token question went through the SECRET channel, not the echoing one.
  assert.equal(secrets1.length, 2, 'admin + atlas token questions both use the muted channel');
  assert.ok(secrets1[1]!.startsWith('Atlas token'), secrets1[1]);
  // Re-run: the atlas default is masked, never echoed.
  const questions: string[] = [];
  const secrets2: string[] = [];
  const qs2 = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'yes', 'https://atlas.example.com', '', 'proj', 'primeagent'];
  let j = 0;
  const errs2: string[] = [];
  const code2 = await runHostSetup(['--yes'], {
    out: () => {}, err: (s) => errs2.push(s),
    question: async (q) => { questions.push(q); return qs2[j++] ?? ''; },
    secretQuestion: async (q: string) => { secrets2.push(q); return qs2[j++] ?? ''; },
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code2, 0, `re-run failed: ${errs2.join('')}`);
  const atlasQ = secrets2.find((q) => q.startsWith('Atlas token'));
  assert.ok(atlasQ, 'the atlas token question must be asked');
  assert.ok(!atlasQ!.includes('atlas-secret-1'), 'the prompt must not echo the live atlas token');
  assert.ok(atlasQ!.includes('<set, 14 chars>'), atlasQ);
  const second = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ATLAS_TOKEN=(.+)/)?.[1];
  assert.equal(second, first, 'enter must keep the existing atlas token');
});

test('the muted channel writes only the prompt — never typed characters or redraws (#649 §1, Copilot round 1)', async () => {
  // Simulate readline's redraw behavior: "<prompt><typed>" chunks must be dropped while
  // the exact prompt string passes through exactly once.
  const written: string[] = [];
  const rlStub = {
    _writeToOutput(s: string) { written.push(s); },
  } as unknown as { _writeToOutput: (s: string) => void };
  const stdoutWrite = rlStub._writeToOutput.bind(rlStub);
  let mutedPrompt: string | null = null;
  rlStub._writeToOutput = (s: string) => {
    if (mutedPrompt !== null) {
      if (s === mutedPrompt) stdoutWrite(s);
      return;
    }
    stdoutWrite(s);
  };
  const prompt = 'Admin/API token [<set, 64 chars> — enter to keep, new value to rotate] ';
  mutedPrompt = prompt;
  // readline invokes the INSTANCE callback (the override) on every write, exactly like
  // the real flow. Redraw: prompt + typed input; a control sequence; another redraw.
  const write = (s: string) => rlStub._writeToOutput(s);
  write(prompt); // readline writes the bare prompt once when question() starts
  write(prompt + 'sk-1234');
  write('\u001b[1K');
  write(prompt + 'sk-123456');
  mutedPrompt = null;
  write('\n');
  const joined = written.join('');
  assert.ok(joined.includes(prompt), 'the prompt is written');
  assert.ok(!joined.includes('sk-'), `the secret must never appear: ${JSON.stringify(joined)}`);
  assert.deepEqual(written, [prompt, '\n'], 'exactly one prompt write and the closing newline');
});

test('without a secretQuestion the token prompts fall back to the plain channel (tests, piped stdin) (#649 §1)', async () => {
  const dir = tempDir('setup-atlas-fallback-');
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'yes', 'https://atlas.example.com', 'atlas-secret-2', 'proj', 'primeagent'];
  let i = 0;
  const code = await runHostSetup([], {
    out: () => {}, err: () => {},
    question: async () => qs[i++] ?? '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes('MERCURY_ATLAS_TOKEN=atlas-secret-2'), 'the fallback still writes the token');
});

test('re-run preserves the existing MERCURY_ADMIN_TOKEN (no silent rotation, #648)', async () => {
  const dir = tempDir('setup-rotate-');
  // Question order: hostName, dataDir, workspaceDir, retention, adminToken, Atlas?, harnesses.
  const qs = ['host-a', join(dir, 'data'), join(dir, 'ws'), '7', '', 'no', 'primeagent'];
  let i = 0;
  const code = await runHostSetup([], {
    out: () => {}, err: () => {},
    question: async () => qs[i++] ?? '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const first = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8').match(/MERCURY_ADMIN_TOKEN=([0-9a-f]{64})/)?.[1];
  assert.ok(first, 'the first run must write a generated token');
  const code2 = await runHostSetup(['--non-interactive', '--yes'], { out: () => {}, err: () => {} }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
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

test('renderEnv: MERCURY_BIND_HOST emitted only when the operator exposes the API (#665)', () => {
  const loopback = renderEnv(answers({ adminToken: 'a'.repeat(64), bindHost: '' }));
  assert.ok(!loopback.includes('MERCURY_BIND_HOST'), 'the secure default must stay in src/config.ts, not the file');
  const exposed = renderEnv(answers({ adminToken: 'a'.repeat(64), bindHost: '0.0.0.0' }));
  assert.ok(exposed.includes('MERCURY_BIND_HOST=0.0.0.0'), exposed);
  const addr = renderEnv(answers({ adminToken: 'a'.repeat(64), bindHost: '192.168.1.10' }));
  assert.ok(addr.includes('MERCURY_BIND_HOST=192.168.1.10'), addr);
});

test('validateAnswer: bindHost accepts loopback/0.0.0.0/addresses, rejects junk (#665)', () => {
  assert.equal(validateAnswer('bindHost', ''), null);
  assert.equal(validateAnswer('bindHost', 'loopback'), null);
  assert.equal(validateAnswer('bindHost', '0.0.0.0'), null);
  assert.equal(validateAnswer('bindHost', 'mercury.example.com'), null);
  assert.ok(validateAnswer('bindHost', '0.0.0.0; rm -rf')!.includes('bind host'), 'shell metacharacters rejected');
  assert.ok(validateAnswer('bindHost', '0 0 0 0')!.includes('bind host'), 'spaces rejected');
});

test('hand-off block: loopback says Fleet cannot reach it; exposed prints the real URL + TLS warning (#665)', async () => {
  // LOOPBACK path: answer the bind question with 'loopback' explicitly.
  const dirLoop = tempDir('setup-bind-loop-');
  const outLoop: string[] = [];
  const qsLoop = ['', '', '', '7', '', 'no', 'primeagent', 'loopback'];
  let iLoop = 0;
  const codeLoop = await runHostSetup([], {
    out: (s) => outLoop.push(s), err: () => {},
    question: async () => qsLoop[iLoop++] ?? '',
    probe: async () => probeOf(['primeagent', 'ok']),
  }, { XDG_CONFIG_HOME: dirLoop });
  assert.equal(codeLoop, 0);
  const textLoop = outLoop.join('');
  assert.ok(textLoop.includes('Fleet cannot reach it'), textLoop);
  assert.ok(!textLoop.includes('host API base URL'), 'no unreachable URL may be printed');
  assert.ok(!textLoop.includes('MERCURY_TLS_CERT'), 'no TLS warning when bound to loopback');
  assert.ok(!readFileSync(envFilePath({ XDG_CONFIG_HOME: dirLoop }), 'utf8').includes('MERCURY_BIND_HOST'), 'the secure default stays in src/config.ts');
});

test('re-run: a preserved TLS value outside the safe charset fails the rewrite (#668 round 9)', async () => {
  const dir = tempDir('setup-tls-unsafe-');
  const cfg = join(dir, 'cfg');
  const mercuryDir = join(cfg, 'mercury');
  mkdirSync(mercuryDir, { recursive: true });
  writeFileSync(join(mercuryDir, 'mercury.env'), 'MERCURY_TLS_CERT=/tmp/$(rm -rf x).pem\nMERCURY_TLS_KEY=/tmp/k.pem\n');
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes'], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('MERCURY_TLS_CERT'), stderr);
  assert.ok(!readFileSync(join(mercuryDir, 'mercury.env'), 'utf8').includes('MERCURY_ADMIN_TOKEN'), 'the file is not rewritten');
});

test('hand-off block: with MERCURY_TLS_CERT/KEY written the base URL is https and no plain-http warning appears (#668 round 6)', async () => {
  const dir = tempDir('setup-bind-tls-');
  const cfg = join(dir, 'cfg');
  const mercuryDir = join(cfg, 'mercury');
  mkdirSync(mercuryDir, { recursive: true });
  // Pre-existing file with TLS configured; the wizard re-runs over it (--answers keeps TLS vars? No —
  // the wizard writes a fresh file). Simplest honest drive: an existing env file + full prompts.
  writeFileSync(join(mercuryDir, 'mercury.env'), 'MERCURY_TLS_CERT=/tmp/c.pem\nMERCURY_TLS_KEY=/tmp/k.pem\n');
  const out: string[] = [];
  const qs = ['', '', '', '7', '', 'no', 'primeagent', '192.168.1.5'];
  let i = 0;
  const code = await runHostSetup(['--yes'], {
    out: (s) => out.push(s), err: () => {},
    question: async () => qs[i++] ?? '',
    probe: async () => probeOf(['primeagent', 'ok']),
  }, { XDG_CONFIG_HOME: cfg });
  assert.equal(code, 0);
  const text = out.join('');
  assert.ok(text.includes('host API base URL: https://192.168.1.5:'), text);
  assert.ok(!text.includes('plain http'), 'no plain-http warning when TLS is configured');
  const envFile = readFileSync(join(mercuryDir, 'mercury.env'), 'utf8');
  assert.ok(envFile.includes('MERCURY_TLS_CERT=/tmp/c.pem'), 'operator TLS vars survive the rewrite');
  assert.ok(envFile.includes('MERCURY_TLS_KEY=/tmp/k.pem'), envFile);
});

test('hand-off block: an explicit 127.0.0.1/localhost bind is still unreachable from Fleet (#668 round 2)', async () => {
  for (const bind of ['127.0.0.1', 'localhost']) {
    const dir = tempDir('setup-bind-impl-');
    const out: string[] = [];
    const qs = ['', '', '', '7', '', 'no', 'primeagent', bind];
    let i = 0;
    const code = await runHostSetup([], {
      out: (s) => out.push(s), err: () => {},
      question: async () => qs[i++] ?? '',
      probe: async () => probeOf(['primeagent', 'ok']),
    }, { XDG_CONFIG_HOME: dir });
    assert.equal(code, 0);
    const text = out.join('');
    assert.ok(text.includes('Fleet cannot reach it'), `${bind}: ${text}`);
    assert.ok(!text.includes('host API base URL'), `${bind}: no URL Fleet cannot use`);
  }
});

test('hand-off block: an exposed bind prints the address and the plain-http/TLS warning (#665, Copilot round 1)', async () => {
  // EXPOSED path: answer the bind question with 0.0.0.0.
  const dir = tempDir('setup-bind-exposed-');
  const out: string[] = [];
  const qs = ['', '', '', '7', '', 'no', 'primeagent', '0.0.0.0'];
  let i = 0;
  const code = await runHostSetup([], {
    out: (s) => out.push(s), err: () => {},
    question: async () => qs[i++] ?? '',
    probe: async () => probeOf(['primeagent', 'ok']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const text = out.join('');
  assert.ok(text.includes('host API base URL: http://<this-host>:'), text);
  assert.ok(text.includes('MERCURY_TLS_CERT'), 'the plain-http warning names the TLS variables');
  const tokens = text.match(/host API token:\s+([0-9a-f]{64})/) ?? [];
  assert.ok(tokens[1], 'token shown');
  const occurrences = out.filter((l) => l.includes(tokens[1]!)).length;
  assert.equal(occurrences, 1, 'token still shown exactly once');
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes('MERCURY_BIND_HOST=0.0.0.0'), file);
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

// ---------- the M2 cross-field gate: probe-driven setup (#647) ----------

function probeOf(...entries: Array<[string, HarnessProbeResult['status'], string?]>): HarnessProbeResult[] {
  return entries.map(([id, status, detail]) => ({
    id, label: id, binary: id, version: status === 'ok' ? '9.9.9' : null, versionRaw: null,
    minVersion: status === 'too-old' ? '9.9.9' : null, status, configPath: '/nonexistent',
    configExists: false, auth: 'unknown' as const, ...(detail ? { error: detail } : {}),
  }));
}

test('default harnesses come from the probe, not a hard-coded list (#647)', async () => {
  const dir = tempDir('setup-probe-def-');
  const out: string[] = [];
  const code = await runHostSetup([], {
    out: (s) => out.push(s), err: () => {},
    question: async () => '', // take every default
    probe: async () => probeOf(['primeagent', 'ok'], ['hermes', 'missing', 'command not found'], ['claude', 'too-old']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes('MERCURY_HARNESSES=primeagent'), `probe-ok harnesses only, got: ${file.split('\n').filter((l) => l.startsWith('MERCURY_HARNESSES'))}`);
  assert.ok(!file.includes('hermes') && !file.includes('claude'), 'a missing or too-old harness must not be enabled by default');
});

test('enabling a too-old harness is rejected; --force overrides (#647)', async () => {
  const dir = tempDir('setup-too-old-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ harnesses: ['hermes'] })));
  const probe = async () => probeOf(['primeagent', 'ok'], ['hermes', 'too-old']);
  const code = await runHostSetup(['--non-interactive', '--answers', answersFile], {
    out: () => {}, err: () => {}, probe,
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 1, 'too-old must be rejected without --force');
  assert.ok(!existsSync(envFilePath({ XDG_CONFIG_HOME: dir })));
  const code2 = await runHostSetup(['--non-interactive', '--answers', answersFile, '--force'], {
    out: () => {}, err: () => {}, probe,
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code2, 0, '--force is the explicit operator override');
});

test('enabling a missing harness is rejected the same way (#647)', async () => {
  const dir = tempDir('setup-missing-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ harnesses: ['claude'] })));
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFile], {
    out: () => {}, err: () => {},
    probe: async () => probeOf(['primeagent', 'ok'], ['claude', 'missing', 'command not found']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 1);
  assert.ok(!existsSync(envFilePath({ XDG_CONFIG_HOME: dir })));
});

test('an unknown probe status enables with a warning, not a rejection (#647)', async () => {
  const dir = tempDir('setup-unknown-');
  const err: string[] = [];
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ harnesses: ['primeagent'] })));
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFile], {
    out: () => {}, err: (s) => err.push(s),
    probe: async () => probeOf(['primeagent', 'unknown', 'unparsable version output']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  // Warnings go to stderr (review #653): stdout stays reserved for the wizard's output.
  assert.ok(err.join('').includes('warning: primeagent probe status unknown'));
});

test('the interactive harness prompt renders the probe checklist (#647)', async () => {
  const dir = tempDir('setup-checklist-');
  const questions: string[] = [];
  const code = await runHostSetup([], {
    out: () => {}, err: () => {},
    question: async (q) => { questions.push(q); return ''; },
    probe: async () => probeOf(['primeagent', 'ok'], ['hermes', 'missing', 'command not found'], ['claude', 'too-old']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const harnessQ = questions.find((q) => q.startsWith('Harnesses to enable'));
  assert.ok(harnessQ, 'the harness question must be asked');
  assert.ok(harnessQ!.includes('primeagent=ok'), harnessQ);
  assert.ok(harnessQ!.includes('hermes=missing'), harnessQ);
  assert.ok(harnessQ!.includes('claude=too-old (needs 9.9.9)'), harnessQ);
});

test('a failed probe degrades to no gate with a warning, not a crash (#647)', async () => {
  const dir = tempDir('setup-probe-fail-');
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {}, err: (s) => err.push(s),
    question: async () => '',
    probe: async () => { throw new Error('probe exploded'); },
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0, 'a broken probe must not block configuration');
  assert.ok(err.join('').includes('probe failed (Error: probe exploded)'));
});

// ---------- the M3 gate: interactive and answers-file agree ----------

test('M3 gate: interactive and answers-file produce byte-identical mercury.env', async () => {
  const dir = tempDir('setup-gate-');
  const answersFile = join(dir, 'answers.json');
  const a = answers({ adminToken: 'tok-admin-gate-1', atlasToken: 'tok-gate-42', atlasEnabled: true, atlasUrl: 'https://atlas.example.com', atlasProject: 'proj' });
  writeFileSync(answersFile, JSON.stringify(a));

  // Interactive path: inject the question function and a deterministic probe (#647).
  const gateProbe: HarnessProbeResult[] = a.harnesses.map((id) => ({
    id, label: id, binary: id, version: '9.9.9', versionRaw: '9.9.9', minVersion: null,
    status: 'ok' as const, configPath: '/nonexistent', configExists: false, auth: 'unknown' as const,
  }));
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
      probe: async () => gateProbe,
    }, { XDG_CONFIG_HOME: dir }).then((code) => {
      if (code !== 0) return rej(new Error(`interactive exit ${code}`));
      res(readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8'));
    });
  });

  // Non-interactive path with the same answers (same injected probe).
  const niEnv = await new Promise<string>((res, rej) => {
    void runHostSetup(['--non-interactive', '--yes', '--answers', answersFile], {
      out: () => {},
      err: () => {},
      probe: async () => gateProbe,
    }, { XDG_CONFIG_HOME: dir }).then((code) => {
      if (code !== 0) return rej(new Error(`non-interactive exit ${code}`));
      res(readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8'));
    });
  });

  assert.equal(interactiveEnv, niEnv, 'interactive and answers-file must produce byte-identical mercury.env');
});

// ---------- the CLI surface ----------

// CLI-level tests use the same hermetic probe stubs as the unit tests (probeStubEnv).

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
    ...probeStubEnv(),
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

test('validateAnswer: values outside the safe charset are rejected (#649 §3)', () => {
  assert.ok(validateAnswer('hostName', 'a\nMERCURY_ADMIN_TOKEN=x')!.includes('safe charset'));
  assert.ok(validateAnswer('adminToken', 'tok$with-dollar')!.includes('safe charset'));
  assert.ok(validateAnswer('dataDir', '/srv/data dir')!.includes('safe charset'));
  assert.ok(validateAnswer('atlasToken', "tok'quote")!.includes('safe charset'));
  assert.ok(validateAnswer('atlasProject', 'p#comment')!.includes('safe charset'));
  // Legitimate values pass: hex admin token, base64-ish atlas token, urls, paths.
  assert.equal(validateAnswer('adminToken', 'a'.repeat(64)), null);
  assert.equal(validateAnswer('atlasToken', 'AbCd1234-_+/='), null);
  assert.equal(validateAnswer('hostName', 'host-01'), null);
  assert.equal(validateAnswer('workspaceDir', '/srv/mercury.workspaces'), null);
});

test('envDiff: redacts credentials, marks changes, and returns empty for identical content (#649 §6)', () => {
  const cur = 'MERCURY_ADMIN_TOKEN=aaaa\nMERCURY_HARNESSES=primeagent\nMERCURY_ATLAS_HOST_ID=h1\n';
  const prop = 'MERCURY_ADMIN_TOKEN=bbbb\nMERCURY_HARNESSES=primeagent\nMERCURY_ATLAS_HOST_ID=h2\nMERCURY_WORKSPACE_RETENTION_MS=604800000\n';
  const d = envDiff(cur, prop);
  assert.ok(d.includes('- MERCURY_ADMIN_TOKEN=<redacted, 4 chars>'), d);
  assert.ok(d.includes('+ MERCURY_ADMIN_TOKEN=<redacted, 4 chars>'), d);
  assert.ok(d.includes('- MERCURY_ATLAS_HOST_ID=h1'), d);
  assert.ok(d.includes('+ MERCURY_ATLAS_HOST_ID=h2'), d);
  assert.ok(d.includes('+ MERCURY_WORKSPACE_RETENTION_MS=604800000'), d);
  assert.ok(!d.includes('MERCURY_HARNESSES'), 'unchanged lines are omitted');
  assert.equal(envDiff(cur, cur), '', 'identical content has no diff');
  // The atlas token is a credential too, and a removed key shows only the '-' line.
  const d2 = envDiff('MERCURY_ATLAS_TOKEN=xyz\nMERCURY_ATLAS_PROJECT=p\n', 'MERCURY_ATLAS_PROJECT=p\n');
  assert.ok(d2.includes('- MERCURY_ATLAS_TOKEN=<redacted, 3 chars>'), d2);
  assert.ok(!d2.includes('+ MERCURY_ATLAS_TOKEN'), 'removed keys have no + line');
  assert.ok(!d2.includes('xyz'), 'the atlas token value never appears');
});

test('re-run with changed answers shows a redacted diff and exits 1 without --yes (#649 §6)', async () => {
  const dir = tempDir('setup-rerun-diff-');
  const cfg = join(dir, 'cfg');
  const mk = (retention: number) => {
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(dir, 'answers.json'), JSON.stringify({
      hostName: 'host-diff',
      dataDir: join(dir, 'data'),
      workspaceDir: join(dir, 'ws'),
      retentionDays: retention,
      adminToken: 'a'.repeat(64),
      atlasEnabled: false,
      harnesses: ['primeagent'],
    }));
  };
  mk(7);
  const first = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(first.code, 0, first.stderr);
  // Same answers, different retention: the guard must show the proposed diff.
  mk(3);
  const second = await cli(['host', 'setup', '--non-interactive', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(second.code, 1);
  assert.ok(second.stdout.includes('Proposed changes'), second.stdout);
  assert.ok(second.stdout.includes('- MERCURY_WORKSPACE_RETENTION_MS=604800000'), second.stdout);
  assert.ok(second.stdout.includes('+ MERCURY_WORKSPACE_RETENTION_MS=259200000'), second.stdout);
  // The token must never appear in the diff.
  assert.ok(!second.stdout.includes('a'.repeat(64)), 'admin token redacted');
  // --yes then applies it.
  const third = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(third.code, 0, third.stderr);
  const envFile = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
  assert.ok(envFile.includes('MERCURY_WORKSPACE_RETENTION_MS=259200000'));
});

test('re-run with identical answers is a no-op that exits 0 (#649 §6)', async () => {
  const dir = tempDir('setup-rerun-same-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({
    hostName: 'host-same',
    dataDir: join(dir, 'data'),
    workspaceDir: join(dir, 'ws'),
    retentionDays: 7,
    adminToken: 'a'.repeat(64),
    atlasEnabled: false,
    harnesses: ['primeagent'],
  }));
  const first = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(first.code, 0, first.stderr);
  const before = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
  const second = await cli(['host', 'setup', '--non-interactive', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(second.code, 0, `identical re-run must succeed: ${second.stderr}`);
  assert.ok(second.stdout.includes('identical'), second.stdout);
  assert.equal(readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8'), before, 'untouched');
});

test('a host name with an embedded newline is rejected before anything is written (#649 §3)', async () => {
  const dir = tempDir('setup-inject-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({
    hostName: 'a\nMERCURY_ADMIN_TOKEN=x',
    dataDir: join(dir, 'data'),
    workspaceDir: join(dir, 'ws'),
    retentionDays: 7,
    adminToken: 'b'.repeat(64),
    atlasEnabled: false,
    harnesses: ['primeagent'],
  }));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('safe charset'), stderr);
  assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')), 'no injected second variable');
});

test('a token containing $ is rejected — bash source would expand it, systemd would not (#649 §3)', async () => {
  const dir = tempDir('setup-dollar-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({
    hostName: 'host-x',
    dataDir: join(dir, 'data'),
    workspaceDir: join(dir, 'ws'),
    retentionDays: 7,
    adminToken: 'b'.repeat(63) + '$',
    atlasEnabled: false,
    harnesses: ['primeagent'],
  }));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('adminToken'), stderr);
  assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')));
});

test('host setup rejects an invalid answer before writing anything', async () => {
  const dir = tempDir('setup-invalid-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ harnesses: ['bogus'] })));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', answersFile], {
    ...probeStubEnv(),
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
    ...probeStubEnv(),
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

test('defaultAnswers: MERCURY_HARNESSES entries are trimmed (review #653)', () => {
  const a = defaultAnswers({ MERCURY_HARNESSES: 'primeagent, claude' } as NodeJS.ProcessEnv);
  // ' claude' with a leading space must survive like the config parser's parseHarnesses.
  assert.deepEqual(a.harnesses, ['primeagent', 'claude']);
});

test('retentionDays 0 is rejected, not silently defaulted', async () => {
  const dir = tempDir('setup-ret0-');
  const answersFile = join(dir, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers({ retentionDays: 0 })));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', answersFile], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('retention must be a positive number of days'));
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')));
});

test('a missing answers file exits cleanly with a message', async () => {
  const dir = tempDir('setup-missing-');
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--answers', join(dir, 'nope.json')], {
    // Hermetic: the probe runs before the answers file is read; stub it so the test
    // never depends on the runner's installed harnesses (review #653).
    ...probeStubEnv(),
    XDG_CONFIG_HOME: dir,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('cannot read answers file'));
});

test('answers file: an unknown key is rejected with a suggestion, nothing written (#649 §2)', async () => {
  const dir = tempDir('setup-answers-strict-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  // `harness` is the issue's own example typo (distance 1 from `harnesses`).
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({ harness: ['primeagent'], hostName: 'h' }));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown key'), stderr);
  assert.ok(stderr.includes("harness (did you mean 'harnesses'?)"), `suggestion missing: ${stderr}`);
  assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')), 'nothing is written when the file has a typo');
});

test('answers file: a non-string bindHost is rejected with the friendly error, not a crash (#668 round 5)', async () => {
  const dir = tempDir('setup-answers-bind-type-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({ bindHost: 7, hostName: 'h' }));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('bind host must be a string'), stderr);
  assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')));
});

test('answers file: bindHost normalizes any case/spacing of the loopback spelling (#668 round 4)', async () => {
  for (const [raw, expect] of [['Loopback', ''], ['  LOOPBACK  ', ''], ['0.0.0.0', '0.0.0.0']] as const) {
    const dir = tempDir('setup-answers-bind-case-');
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(dir, 'answers.json'), JSON.stringify({ bindHost: raw, hostName: 'h' }));
    const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
      ...probeStubEnv(),
      XDG_CONFIG_HOME: cfg,
    });
    assert.equal(code, 0, stderr);
    const envFile = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
    assert.equal(envFile.includes('MERCURY_BIND_HOST'), expect !== '', `${raw}: ${envFile}`);
    if (expect) assert.ok(envFile.includes(`MERCURY_BIND_HOST=${expect}`), envFile);
  }
});

test('answers file: a near-miss key with no close match is rejected without a suggestion (#649 §2)', async () => {
  const dir = tempDir('setup-answers-strict2-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(dir, 'answers.json'), JSON.stringify({ totallyUnrelatedKeyName: 'x' }));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('totallyUnrelatedKeyName'), stderr);
  assert.ok(!stderr.includes('did you mean'), 'no dishonest suggestion for a far-off key');
  assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')));
});

test('answers file: non-object JSON (null, scalar, array) is rejected, nothing written (#649 §2)', async () => {
  for (const content of ['null', 'true', '1', '"x"', '[]']) {
    const dir = tempDir('setup-answers-nonobj-');
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(dir, 'answers.json'), content);
    const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
      ...probeStubEnv(),
      XDG_CONFIG_HOME: cfg,
    });
    assert.equal(code, 1, `content ${content} must be rejected`);
    assert.ok(stderr.includes('must be a JSON object'), `message for ${content}: ${stderr}`);
    assert.ok(!existsSync(join(cfg, 'mercury', 'mercury.env')), `nothing written for ${content}`);
  }
});

test('answers file: every known key is accepted (#649 §2)', async () => {
  const dir = tempDir('setup-answers-ok-');
  const cfg = join(dir, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const answers = {
    hostName: 'host-answers',
    dataDir: join(dir, 'data'),
    workspaceDir: join(dir, 'ws'),
    retentionDays: 3,
    adminToken: 'a'.repeat(64),
    atlasEnabled: false,
    atlasUrl: '',
    atlasToken: '',
    atlasProject: '',
    harnesses: ['primeagent'],
  };
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
  const { code, stderr } = await cli(['host', 'setup', '--non-interactive', '--yes', '--answers', join(dir, 'answers.json')], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
  });
  assert.equal(code, 0, stderr);
  const envFile = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
  assert.ok(envFile.includes('MERCURY_ATLAS_HOST_ID=host-answers'));
  assert.ok(envFile.includes('MERCURY_WORKSPACE_RETENTION_MS=259200000'), '3 days in ms');
});

test('re-run on a configured host refuses to overwrite without --yes (M5 gate)', async () => {
  const dir = tempDir('setup-rerun-');
  const cfg = join(dir, 'cfg');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_ATLAS_HOST_ID=old\n');
  const { code, stdout } = await cli(['host', 'setup', '--non-interactive'], {
    ...probeStubEnv(),
    XDG_CONFIG_HOME: cfg,
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes('already exists'));
  // The file is untouched.
  const content = readFileSync(join(cfg, 'mercury', 'mercury.env'), 'utf8');
  assert.ok(content.includes('MERCURY_ATLAS_HOST_ID=old'));
});


// ---------- the opt-in Laya sidecar step (#831) ----------

function okRun(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  if (argv[0] === 'uv' && argv[1] === 'python') return { ok: true, stdout: '/Users/x/.uv/py3.10/bin/python3', stderr: '' };
  if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.10.12', stderr: '' };
  return { ok: true, stdout: '', stderr: '' };
}

test('detectPython: uv-preferred, >= 3.10 ok (#831)', () => {
  const det = detectPython(okRun, DEFAULT_PYTHON_CANDIDATES);
  assert.equal(det.ok, true);
  assert.match(det.bin ?? '', /uv run --python >=3\.10/, 'uv-managed interpreter wins');
});

test('detectPython: macOS system 3.9.6 is refused WITH the reason (#831)', () => {
  const run = (argv: string[]) =>
    argv[0] === 'uv'
      ? { ok: false, stdout: '', stderr: 'no 3.10' }
      : { ok: true, stdout: 'Python 3.9.6', stderr: '' };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES, 'darwin');
  assert.equal(det.ok, false);
  assert.match(det.reason ?? '', /system Python on macOS is too old \(Python 3\.9\.6\)/);
  assert.match(det.reason ?? '', /need >= 3\.10/);
});

test('detectPython: a non-darwin 3.9 gets the plain too-old reason (#831)', () => {
  const run = (argv: string[]) => ({ ok: true, stdout: 'Python 3.9.1', stderr: '' });
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES.slice(1), 'linux');
  assert.equal(det.ok, false);
  assert.match(det.reason ?? '', /python too old/);
  assert.ok(!/macOS/.test(det.reason ?? ''), 'the macOS wording is platform-specific');
});

test('parsePythonVersion: tuple semantics — 3.9.10 must NOT read as 3.10 (#840 r1)', () => {
  assert.deepEqual(parsePythonVersion('Python 3.9.6'), [9, 6]);
  assert.deepEqual(parsePythonVersion('Python 3.9.10'), [9, 10], 'two-digit patch stays on 3.9');
  assert.deepEqual(parsePythonVersion('Python 3.10.0'), [10, 0]);
  assert.deepEqual(parsePythonVersion('Python 3.12.4'), [12, 4]);
  assert.equal(parsePythonVersion('no version here'), null);
});

test('detectPython: a python3.14-only Homebrew host passes the >= 3.10 gate (#840 r8)', () => {
  // macOS: no uv, stock python3 3.9.6, Homebrew python3.14 — the advertised gate is >= 3.10,
  // not a pinned series, so this host must be accepted.
  const run = (argv: string[]) => {
    if (argv[0] === 'uv') return { ok: false, stdout: '', stderr: 'no uv' };
    if (argv[0] === 'python3.14') return { ok: true, stdout: 'Python 3.14.0', stderr: '' };
    if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
    return { ok: false, stdout: '', stderr: 'no' };
  };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES);
  assert.equal(det.ok, true);
  assert.equal(det.bin, 'python3.14');
  assert.equal(det.version, '3.14.0');
});

test('discoverVersionedPythons: unbounded PATH discovery appends python3.N (N >= 10), newest first (#840 r8)', () => {
  const dir = tempDir('laya-pydisc-');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const name of ['python3.9', 'python3.99', 'python3.12', 'python3.10', 'python3']) {
    writeFileSync(join(dir, 'bin', name), '#!/bin/sh\n', { mode: 0o755 });
  }
  const env = { PATH: `/nope:${dir}/bin` };
  const found = discoverVersionedPythons(env, DEFAULT_PYTHON_CANDIDATES);
  assert.deepEqual(found.map((c) => c.argv[0]), [join(dir, 'bin', 'python3.99')], 'python3.99 is discovered (no upper bound); python3.12/3.10 are already probed; python3.9 and bare python3 are below the gate');
  assert.equal(found[0]!.bin, join(dir, 'bin', 'python3.99'));
  // A PATH entry that does not exist is skipped, and an empty PATH yields nothing.
  assert.deepEqual(discoverVersionedPythons({ PATH: '' }, DEFAULT_PYTHON_CANDIDATES), []);
});

test('detectPython: a discovered out-of-list interpreter wins over the old system shim (#840 r8)', () => {
  const dir = tempDir('laya-pydet-');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  // python3.16 is deliberately NOT in the static list — discovery must pick it up.
  writeFileSync(join(dir, 'bin', 'python3.16'), '#!/bin/sh\n', { mode: 0o755 });
  const located = join(dir, 'bin', 'python3.16');
  const run = (argv: string[]) => {
    if (argv[0] === 'uv') return { ok: false, stdout: '', stderr: 'no uv' };
    if (argv[0] === located) return { ok: true, stdout: 'Python 3.14.1', stderr: '' };
    if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
    return { ok: false, stdout: '', stderr: 'no' };
  };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES, 'darwin', { PATH: `${dir}/bin` });
  assert.equal(det.ok, true);
  assert.equal(det.bin, located, 'the discovered interpreter is probed through the same run fn');
  assert.equal(det.version, '3.14.1');
  // The uv bin label carries the >=3.10 request now (r8).
  assert.equal(detectPython((a) => (a[0] === 'uv' ? { ok: true, stdout: located, stderr: '' } : { ok: true, stdout: 'Python 3.14.0', stderr: '' }), DEFAULT_PYTHON_CANDIDATES).bin, 'uv run --python >=3.10 python3');
});

test('detectPython: Homebrew versioned interpreters are probed before the plain python3 (#840 r6)', () => {
  // The stock-macOS recovery path: brew python@3.12 exposes python3.12 on PATH while the
  // unversioned python3 shim stays 3.9.6. Detection must find python3.12, not the shim.
  const run = (argv: string[]) => {
    if (argv[0] === 'uv') return { ok: false, stdout: '', stderr: 'no uv' };
    if (argv[0] === 'python3.12') return { ok: true, stdout: 'Python 3.12.2', stderr: '' };
    if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
    return { ok: false, stdout: '', stderr: 'no' };
  };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES);
  assert.equal(det.ok, true);
  assert.equal(det.bin, 'python3.12', 'the versioned Homebrew interpreter wins over the old shim');
  assert.equal(det.version, '3.12.2');
});

test('detectPython: uv python find output (an interpreter PATH) is verified with -V, not parsed (#840 r5)', () => {
  // A uv-only host whose resolved path has no '3.10' component: parse-the-path would read
  // version null and reject a valid install. The python3 fallback answers 3.9 (too old), so
  // ONLY a correct uv verify can make this succeed.
  const run = (argv: string[]) => {
    if (argv[0] === 'uv') return { ok: true, stdout: '/opt/python/bin/python3', stderr: '' };
    if (argv[0] === '/opt/python/bin/python3' && argv[1] === '-V') return { ok: true, stdout: 'Python 3.10.4', stderr: '' };
    if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
    return { ok: false, stdout: '', stderr: '' };
  };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES);
  assert.equal(det.ok, true, 'the located interpreter is verified by running it with -V');
  assert.equal(det.bin, 'uv run --python >=3.10 python3', 'the uv candidate won');
  assert.equal(det.version, '3.10.4');
});

test('detectPython: a uv-located interpreter that cannot run is not silently accepted (#840 r5)', () => {
  // No usable fallback (system python 3.9.6): the uv path must NOT parse the find output as a
  // version (the old bug accepted the candidate by reading '3' patterns out of the path).
  const run = (argv: string[]) => {
    if (argv[0] === 'uv') return { ok: true, stdout: '/opt/python3.10/bin/python3', stderr: '' };
    if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
    return { ok: false, stdout: '', stderr: 'no' };
  };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES);
  assert.equal(det.ok, false, 'a uv locate whose interpreter cannot be run must fail (no path parsing)');
  assert.ok(!det.reason?.includes('/opt/python3.10/bin'), 'the found PATH must not be quoted as a version');
  assert.match(det.reason ?? '', /too old/);
});

test('detectPython: 3.9.10 (two-digit patch) is REFUSED — order-preserving compare (#840 r1)', () => {
  const run = (argv: string[]) =>
    argv[0] === 'uv'
      ? { ok: false, stdout: '', stderr: 'no' }
      : { ok: true, stdout: 'Python 3.9.10', stderr: '' };
  const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES.slice(1), 'linux');
  assert.equal(det.ok, false, '3.9.10 packs to the same number as 3.10 under minor*10+patch');
  assert.match(det.reason ?? '', /too old/);
});

test('planLayaSidecar: user-scoped venv under the data dir + user-scoped unit (#831)', () => {
  const plan = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'darwin', env: { HOME: '/home/x' } });
  assert.equal(plan.venvDir, '/data/laya-venv');
  assert.equal(plan.envUrl, 'http://127.0.0.1:8302');
  assert.match(plan.unitPath, /Library\/LaunchAgents\/com\.mercury\.laya\.plist$/);
  const linux = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } });
  assert.match(linux.unitPath, /systemd\/user\/com\.mercury\.laya\.service$/);
});

test('laya units carry the same restart backoff as the host and bot units (#840 r4)', () => {
  const plan = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } });
  const unit = renderLayaSystemdUnit(plan, 'k');
  assert.match(unit, /Restart=on-failure[\s\S]{0,120}RestartSec=5[\s\S]{0,60}TimeoutStopSec=15/, 'no tight failure loop');
  const darwin = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'darwin', env: { HOME: '/home/x' } });
  assert.match(renderLayaLaunchdPlist(darwin, 'k'), /<key>ThrottleInterval<\/key><integer>5<\/integer>/);
});

test('ensureLayaCredentials: generation REPLACES the file atomically (#840 r14)', () => {
  // The file is shared across bots: a truncate-in-place that dies mid-write would lose every
  // credential, and a loose-mode file would expose the new key until the trailing chmod. The
  // generation path must write 0600 temp + fsync + rename and leave NO temp behind.
  const dir = tempDir('laya-creds-atomic-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  // An existing loose-mode file with ANOTHER bot's entry: the other entry must survive and the
  // mode must end at 0600.
  writeFileSync(path, JSON.stringify({ maint: { api: 'm'.repeat(64) } }), { mode: 0o644 });
  const r = ensureLayaCredentials(env);
  assert.equal(r.generated, true);
  assert.match(r.key, /^[0-9a-f]{64}$/);
  const written = JSON.parse(readFileSync(path, 'utf8')) as { maint?: { api?: string }; laya?: { api?: string } };
  assert.equal(written.maint?.api, 'm'.repeat(64), 'the other bot entry survives');
  assert.equal(written.laya?.api, r.key);
  assert.equal((statSync(path).mode & 0o777).toString(8), '600', 'the replaced file is 0600');
  const leftovers = readdirSync(join(dir, 'mercury')).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `no temp file remains: ${leftovers.join(', ')}`);
});

test('ensureLayaCredentials: the WHOLE preserved entry is validated against the shared schema (#840 r7)', () => {
  // The doctor reads this entry through readBotCredentials (unknown keys, non-empty/unpadded
  // values for api AND llm). Setup must refuse what the reader would refuse — not write the
  // unit, report success, and leave doctor failing (Copilot #840 r7).
  const dir = tempDir('laya-creds-schema-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  for (const [label, entry] of [
    ['unknown key', { api: 'a'.repeat(64), token: 'stale' }],
    ['bad llm type', { api: 'a'.repeat(64), llm: 42 }],
  ] as const) {
    writeFileSync(path, JSON.stringify({ laya: entry }), { mode: 0o600 });
    let msg = '';
    try {
      ensureLayaCredentials(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.ok(msg, `${label}: refused`);
    assert.match(msg, /bot-credentials\.json/, 'the file is named');
    assert.ok(!msg.includes('stale') && !msg.includes('a'.repeat(64)), 'no value is echoed');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), `no unit write after a ${label} refusal`);
  }
  // The did-you-mean hint survives (same wording the reader has always used).
  writeFileSync(path, JSON.stringify({ laya: { api: 'a'.repeat(64), token: 'stale' } }), { mode: 0o600 });
  let msg2 = '';
  try {
    ensureLayaCredentials(env);
  } catch (e) {
    msg2 = (e as Error).message;
  }
  assert.match(msg2, /unknown key 'token' \(did you mean 'api'\?\)/);
  // A VALID preserved entry (api + llm) still passes and is preserved untouched.
  writeFileSync(path, JSON.stringify({ laya: { api: 'b'.repeat(64), llm: 'c'.repeat(32) } }), { mode: 0o600 });
  const r = ensureLayaCredentials(env);
  assert.equal(r.generated, false);
  assert.equal(r.key, 'b'.repeat(64));
});

test('ensureLayaCredentials: a padded or empty preserved api is refused at setup time (#840 r4)', () => {
  const dir = tempDir('laya-creds-padded-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  // Padded: readBotCredentials would reject it AFTER setup claimed success — refuse now.
  writeFileSync(path, JSON.stringify({ laya: { api: ' key ' } }), { mode: 0o600 });
  let msg = '';
  try {
    ensureLayaCredentials(env);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /leading or trailing whitespace/);
  assert.ok(!msg.includes('key'), 'the value is never included in the error');
  // Empty: same refusal class.
  writeFileSync(path, JSON.stringify({ laya: { api: '  ' } }), { mode: 0o600 });
  assert.throws(() => ensureLayaCredentials(env), /must be a non-empty string/);
  // Malformed entry shape: refused, never silently overwritten.
  writeFileSync(path, JSON.stringify({ laya: 'nope' }), { mode: 0o600 });
  assert.throws(() => ensureLayaCredentials(env), /must be an object with a non-empty string 'api'/);
});

test('sidecarExec: a timed-out command with empty stderr keeps the ETIMEDOUT diagnosis (#840 r9)', () => {
  // spawnSync sets r.error but leaves stderr '' on timeout; the old `stderr ?? error` collapsed
  // that into 'no output' and a hung uv/pip looked like silence.
  const r = sidecarExec(['sleep', '5'], 150);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /ETIMEDOUT|timed? ?out/i, `the timeout is diagnosed: ${r.stderr}`);
});

test('renderLayaLaunchdPlist / renderLayaSystemdUnit: loopback, preload, english, key; deterministic (#831)', () => {
  const plan = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'darwin', env: { HOME: '/home/x' } });
  const plist = renderLayaLaunchdPlist(plan, 'key-1');
  assert.ok(plist.includes('<key>LAYA_HOST</key><string>127.0.0.1</string>'), 'loopback bind');
  assert.ok(plist.includes('<key>LAYA_PRELOAD</key><string>1</string>'));
  assert.ok(plist.includes('<key>LAYA_MODELS</key><string>english</string>'));
  // Design §5.3 "weights cached there": HF_HOME is pinned INSIDE the Mercury data dir (r16) —
  // without it the ~843 MB checkpoint lands in the user's global cache.
  assert.ok(plist.includes(`<key>HF_HOME</key><string>/data/laya-hf</string>`), `HF_HOME pinned: ${plist.includes('HF_HOME')}`);
  // r20: stdout/stderr are captured beside the venv — a preload failure's Python error must
  // not be lost (the failure hint points the operator at launchctl print, not the log file).
  assert.ok(plist.includes('<key>StandardOutPath</key><string>/data/laya-sidecar.log</string>'));
  assert.ok(plist.includes('<key>StandardErrorPath</key><string>/data/laya-sidecar.log</string>'));
  assert.ok(plist.includes('<string>key-1</string>'));
  assert.equal(renderLayaLaunchdPlist(plan, 'key-1'), plist, 'same plan → same bytes');
  const linux = planLayaSidecar({ dataDir: '/data', pythonBin: 'python3', platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } });
  const unit = renderLayaSystemdUnit(linux, 'key-2');
  assert.ok(unit.includes('Environment=LAYA_HOST=127.0.0.1'));
  assert.ok(unit.includes(`Environment=LAYA_PORT=${linux.port}`));
  assert.ok(unit.includes('Environment=LAYA_PRELOAD=1'));
  assert.ok(unit.includes('Environment=LAYA_MODELS=english'));
  assert.ok(unit.includes(`Environment=HF_HOME=/data/laya-hf`), 'HF_HOME pinned under the data dir (r16)');
  assert.equal(renderLayaSystemdUnit(linux, 'key-2'), unit, 'same plan → same bytes');
  assert.ok(layaStepActions(plan).some((a) => a.includes(`laya[serve]==${LAYA_SERVE_PIN}`)), 'the pinned version is in the plan');
  // The printed plan mirrors EXECUTION (Copilot #840 r2): env write first, then the venv with
  // the actual tool, then install, then the unit.
  const actions = layaStepActions(plan);
  assert.ok(actions[0]!.startsWith('write env:'), 'mercury.env is written first');
  assert.match(actions[1]!, /uv venv .* --seed/, 'the uv path seeds pip');
  const pyActions = layaStepActions(plan, 'python3');
  assert.match(pyActions[1]!, /python3 -m venv/, 'the fallback path prints the fallback tool');
});

test('ensureLayaCredentials: generates when absent, PRESERVES an existing key (#831)', () => {
  const dir = tempDir('laya-creds-');
  const env = { XDG_CONFIG_HOME: dir };
  const first = ensureLayaCredentials(env);
  assert.equal(first.generated, true);
  assert.match(first.key, /^[0-9a-f]{64}$/);
  const file = readFileSync(join(dir, 'mercury', 'bot-credentials.json'), 'utf8');
  assert.equal((statSync(join(dir, 'mercury', 'bot-credentials.json')).mode & 0o777).toString(8), '600', '0600 on create');
  const second = ensureLayaCredentials(env);
  assert.equal(second.generated, false, 'a re-run preserves the key');
  assert.equal(second.key, first.key);
  // An existing entry with a DIFFERENT shape still counts as absent (api missing) and is
  // filled in without touching the rest of the file.
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ maint: { api: 'tok-x' } }), { mode: 0o600 });
  const third = ensureLayaCredentials(env);
  assert.equal(third.generated, true);
  const raw = JSON.parse(readFileSync(join(dir, 'mercury', 'bot-credentials.json'), 'utf8')) as { maint?: unknown };
  assert.ok(raw.maint, 'the pre-existing alias entry survives');
});

test('ensureLayaCredentials: an array root or invalid JSON is REFUSED, secrets never leak (#840 r2)', () => {
  const dir = tempDir('laya-creds-shape-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  // A valid-JSON array would swallow the .laya assignment and setup would report success
  // while the key was never persisted.
  writeFileSync(path, '[]', { mode: 0o600 });
  assert.throws(() => ensureLayaCredentials(env), /must be a JSON object keyed by bot alias/);
  // An invalid JSON file whose excerpt would carry a planted secret: the error names the
  // failure, never the content.
  writeFileSync(path, '{"laya": {"api": sk-9f88-tok}}', { mode: 0o600 });
  try {
    ensureLayaCredentials(env);
    assert.fail('invalid JSON must refuse');
  } catch (e) {
    assert.match((e as Error).message, /not valid JSON/);
    assert.ok(!/9f88/.test((e as Error).message), 'the parse-error excerpt must not carry the secret');
  }
});

test('ensureLayaCredentials: keys that cannot be embedded in a unit are REFUSED (#840 r5)', () => {
  const dir = tempDir('laya-creds-charset-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  for (const bad of ['a&b', 'a b', 'a\nb', 'a"b', 'a b; c']) {
    writeFileSync(path, JSON.stringify({ laya: { api: bad } }), { mode: 0o600 });
    let msg = '';
    try {
      ensureLayaCredentials(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /cannot be embedded in the service unit/, `key ${JSON.stringify(bad)} refused`);
    assert.ok(!msg.includes(bad), 'the value is never echoed');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'no unit write happens after a refusal');
  }
  // Hex keys — the wizard-generated shape — always pass.
  writeFileSync(path, JSON.stringify({ laya: { api: 'a'.repeat(64) } }), { mode: 0o600 });
  const r = ensureLayaCredentials(env);
  assert.equal(r.generated, false);
  assert.equal(r.key, 'a'.repeat(64));
});

test('ensureLayaCredentials: a PRESERVED key in a drifted 0644 file is still repaired (#840 r3)', () => {
  const dir = tempDir('laya-creds-preserve-mode-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  writeFileSync(path, JSON.stringify({ laya: { api: 'existing-laya-key' } }), { mode: 0o644 });
  const r = ensureLayaCredentials(env);
  assert.equal(r.generated, false, 'the existing key is preserved');
  assert.equal(r.key, 'existing-laya-key');
  assert.equal((statSync(path).mode & 0o777).toString(8), '600', 'the drifted mode is repaired on the preserved path too');
});

test('ensureLayaCredentials: an EXISTING loose-mode file is repaired to 0600 (#840 r1)', () => {
  const dir = tempDir('laya-creds-mode-');
  const env = { XDG_CONFIG_HOME: dir };
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  writeFileSync(path, JSON.stringify({ maint: { api: 'tok-x' } }), { mode: 0o644 });
  const r = ensureLayaCredentials(env);
  assert.equal(r.generated, true);
  assert.equal((statSync(path).mode & 0o777).toString(8), '600', 'the key must never land in a world-readable file');
});

test('runHostSetup: Laya OPT-OUT writes no MERCURY_LAYA_URL and nothing else changes (#831)', async () => {
  const dir = tempDir('setup-laya-off-');
  const out: string[] = [];
  const code = await runHostSetup([], {
    out: (s) => out.push(s),
    err: () => {},
    question: async () => '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(!file.includes('MERCURY_LAYA_URL'), 'opt-out must not write the env key');
  assert.ok(!existsSync(join(dir, 'mercury', 'bot-credentials.json')), 'opt-out must not write credentials');
});

test('runHostSetup: Laya OPT-IN writes MERCURY_LAYA_URL + credentials + unit (scripted exec) (#831)', async () => {
  const dir = tempDir('setup-laya-on-');
  // The wizard loads the unit and verifies with the doctor's probe (r10): a fake sidecar on the
  // wizard's fixed port answers it. Auth off — the generated key is not known up front.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  const sidecarCalls: string[][] = [];
  const out: string[] = [];
  let answersMode = false;
  try {
  const code = await runHostSetup([], {
    out: (s) => out.push(s),
    err: () => {},
    question: async (q) => {
      // Answer '' to every question except the laya one (default no) — flip it to yes.
      if (q.includes('Laya sidecar')) return 'yes';
      return '';
    },
    sidecarRun: (argv) => {
      sidecarCalls.push(argv);
      return okRun(argv);
    },
    sidecarDataDir: join(dir, 'data'),
    // The fake answers immediately; shrink the readiness window (r11 knob).
    sidecarReadinessBudgetMs: 30_000,
      sidecarProbeUrl: `${fake.url}`,
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
  assert.equal(code, 0, `setup failed: ${out.join('')}`);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes('MERCURY_LAYA_URL=http://127.0.0.1:8302'), 'the opt-in writes the env key');
  assert.ok(sidecarCalls.some((a) => a.join(' ').includes('venv')), 'uv venv ran');
  assert.ok(sidecarCalls.some((a) => a.join(' ').includes(`laya[serve]==${LAYA_SERVE_PIN}`)), 'the pinned install ran');
  assert.ok(existsSync(join(dir, 'mercury', 'bot-credentials.json')), 'credentials written');
  const creds = JSON.parse(readFileSync(join(dir, 'mercury', 'bot-credentials.json'), 'utf8')) as { laya?: { api?: string } };
  assert.match(creds.laya?.api ?? '', /^[0-9a-f]{64}$/);
  assert.ok(out.join('').includes('mercury host doctor'), 'the wizard points at the doctor line');
  assert.ok(out.join('').includes('laya: doctor ok'), 'the run finishes with the doctor probe green (r10)');
  assert.ok(fake.received.length >= 1, 'the probe reached the sidecar');
  // macOS r12: bootout the loaded job, then bootstrap the NEW plist (kickstart would serve the
  // cached job definition). Asserted where launchctl exists (darwin; CI's ubuntu job skips).
  if (process.platform === 'darwin') {
    const sub = sidecarCalls.map((a) => a[1] ?? '');
    assert.ok(sub.includes('bootout'), `bootout before bootstrap: ${sidecarCalls.map((c) => c.join(' ')).join(' | ')}`);
    assert.ok(sub.includes('bootstrap'), 'bootstrap runs');
    assert.ok(sub.indexOf('bootout') < sub.indexOf('bootstrap'), 'bootout precedes bootstrap');
  }
  } finally {
    await fake.close();
  }
});

test('runHostSetup: Laya re-run preserves an existing key (#831)', async () => {
  const dir = tempDir('setup-laya-rerun-');
  // Both runs verify through the doctor probe (r10) — a fake sidecar on the fixed port answers.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    // First run: opt-in (establishes the key).
    await runHostSetup([], {
      out: () => {},
      err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
    sidecarProbeUrl: `${fake.url}`,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    const credsPath = join(dir, 'mercury', 'bot-credentials.json');
    const firstKey = (JSON.parse(readFileSync(credsPath, 'utf8')) as { laya: { api: string } }).laya.api;
    // Second run: env now carries MERCURY_LAYA_URL (default yes), re-run with --yes.
    const out: string[] = [];
    const code = await runHostSetup(['--yes'], {
      out: (s) => out.push(s),
      err: () => {},
      question: async () => '',
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
    sidecarProbeUrl: `${fake.url}`,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_URL: 'http://127.0.0.1:8302' });
    assert.equal(code, 0, `re-run failed: ${out.join('')}`);
    const secondKey = (JSON.parse(readFileSync(credsPath, 'utf8')) as { laya: { api: string } }).laya.api;
    assert.equal(secondKey, firstKey, 'the re-run must NOT rotate the sidecar key');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: an invalid MERCURY_LAYA_TIMEOUT_MS refuses with the doctor wording (#840 r12)', async () => {
  // The success gate claims to be the doctor check — it must fail exactly where the doctor
  // would, including the timeout configuration the doctor rejects.
  const dir = tempDir('setup-laya-badtimeout-');
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  const err: string[] = [];
  try {
    // Pre-seed the env file with an invalid timeout: first run writes mercury.env, so run twice.
    await runHostSetup([], {
      out: () => {},
      err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
    sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    const envPath = envFilePath({ XDG_CONFIG_HOME: dir });
    writeFileSync(envPath, readFileSync(envPath, 'utf8') + 'MERCURY_LAYA_TIMEOUT_MS=0\n');
    const code = await runHostSetup(['--yes'], {
      out: () => {},
      err: (s) => err.push(s),
      question: async () => '',
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
    sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 1);
    assert.ok(err.join('').includes('MERCURY_LAYA_TIMEOUT_MS must be a positive integer'), `doctor wording: ${err.join('')}`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: the venv step uses the EXACT located interpreter (spaces included) (#840 r15)', async () => {
  // A discovered interpreter under a directory with a space: splitting det.bin would truncate
  // the path; the step must replay det.argv[0] verbatim.
  const dir = tempDir('laya-pyspace-');
  // python3.16: deliberately NOT in the static list, so only PATH discovery can find it.
  const spacedBin = join(dir, 'Jane Doe', 'bin', 'python3.16');
  mkdirSync(join(dir, 'Jane Doe', 'bin'), { recursive: true });
  writeFileSync(spacedBin, '#!/bin/sh\n', { mode: 0o755 });
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  const venvArgv: string[][] = [];
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => process.stderr.write(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: (argv: string[]) => {
        if (argv[1] === '-m' && argv[2] === 'venv') venvArgv.push(argv);
        if (argv[0] === 'uv') return { ok: false, stdout: '', stderr: 'no uv' };
        if (argv[0] === spacedBin && argv[1] === '-V') return { ok: true, stdout: 'Python 3.16.0', stderr: '' };
        if (argv[1] === '-V') return { ok: true, stdout: 'Python 3.9.6', stderr: '' };
        return okRun(argv);
      },
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
        sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, PATH: `${join(dir, 'Jane Doe', 'bin')}:${process.env.PATH ?? ''}` });
    assert.equal(code, 0);
    assert.ok(venvArgv.length >= 1, 'the venv step ran');
    assert.equal(venvArgv[0]![0], spacedBin, `the exact spaced path is used: ${venvArgv[0]?.join(' ')}`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: an EMPTY process MERCURY_LAYA_URL keeps the configured endpoint (#840 r42)', async () => {
  // The invoking shell carries MERCURY_LAYA_URL=''; the configured external endpoint in
  // mercury.env must keep its continuity — not be rewritten to the local default and installed
  // over.
  const dir = tempDir('setup-laya-emptyenv-');
  const KEY = 'k'.repeat(32);
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: KEY });
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  // The CONFIGURED state: a previous setup wrote the external endpoint into mercury.env.
  writeFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), `MERCURY_LAYA_URL=${fake.url}\n`);
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: KEY } }), { mode: 0o600 });
  const outx: string[] = [];
  const errx: string[] = [];
  try {
    const code = await runHostSetup(['--yes'], {
      out: (s) => outx.push(s),
      err: (s) => errx.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_URL: '' });
    assert.equal(code, 0, `continuity run: ${errx.join('')} | ${outx.join('')}`);
    const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
    assert.ok(file.includes(`MERCURY_LAYA_URL=${fake.url}`), 'the configured endpoint survives');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'no local sidecar installed over the external endpoint');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a PADDED layaUrl in an existing mercury.env is refused on re-run (#840 r38)', async () => {
  // existingVar trimmed the persisted value, silently normalizing (or dropping) what
  // loadConfig and the doctor refuse. The file value reaches validation raw.
  const dir = tempDir('setup-laya-filepad-');
  const cfgDir = join(dir, 'mercury');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'MERCURY_LAYA_URL= http://127.0.0.1:8302 \n');
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {},
    err: (s) => err.push(s),
    question: async () => '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
  assert.equal(code, 1);
  assert.match(err.join(''), /must not have leading or trailing whitespace/);
  assert.match(readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8'), /MERCURY_LAYA_URL= http/, 'the file is untouched');
});

test('sidecarExec: the timeout holds even when the child ignores SIGTERM (#840 r40)', () => {
  // spawnSync's default SIGTERM is catchable: a child trapping it would hang the installer past
  // the bound. SIGKILL is uncatchable — the run must return within ~2 s of the 300 ms timeout.
  const t0 = Date.now();
  const r = sidecarExec([process.execPath, '-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`], 300);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(elapsed < 5_000, `the bound holds: ${elapsed} ms`);
});

test('runHostSetup: the venv is rebuilt at its final path; a failed install rolls back (#840 r47/r55)', async () => {
  // Scripted runner that REALLY creates the venv dir so the rebuild works on the real fs.
  const dir = tempDir('setup-laya-stage-');
  const live = join(dir, 'data', 'laya-venv');
  const installedMarker = join(live, 'bin', '.laya-installed');
  let failInstall = false;
  const sidecarRun = (argv: string[]) => {
    if (argv[0] === 'uv' && argv[1] === 'venv') {
      const target = argv[2]!;
      // `uv venv` REPLACES an existing venv — emulate that so the rollback discipline is
      // observable (a recreate wipes the previous install's files).
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
    } else if (argv.includes('pip')) {
      if (failInstall) return { ok: false, stdout: '', stderr: 'boom' };
      // pip installs into the venv that invoked it — always the FINAL path now (r55: a venv
      // cannot be promoted by renaming; pip writes absolute shebangs).
      assert.ok(!argv[0]!.includes('.staging-'), `pip must run from the final venv path, got ${argv[0]}`);
      const venvBin = dirname(argv[0]!);
      assert.equal(venvBin, join(live, 'bin'), 'pip targets the live venv');
      mkdirSync(venvBin, { recursive: true });
      writeFileSync(join(venvBin, '.laya-installed'), 'ok\n');
    }
    return okRun(argv);
  };
  const err: string[] = [];
  // Operator data beside the venv (NOT installer naming) and a crashed run's leftover.
  mkdirSync(join(dir, 'data', 'laya-venv.backup-manual'), { recursive: true });
  writeFileSync(join(dir, 'data', 'laya-venv.backup-manual', 'keep.txt'), 'operator data\n');
  mkdirSync(join(dir, 'data', 'laya-venv.backup-weird.pid'), { recursive: true });
  mkdirSync(join(dir, 'data', 'laya-venv.backup-999999'), { recursive: true });
  // First run: healthy install → live venv exists, no backup leftovers.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    const code = await runHostSetup([], {
      out: () => {}, err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 0, `install: ${err.join('')}`);
    assert.ok(existsSync(live), 'the live venv exists after the rebuild');
    assert.ok(existsSync(installedMarker), 'the install landed in the live venv');
    assert.ok(!readdirSync(join(dir, 'data')).some((e) => /^laya-venv\.(staging|backup)-\d+$/.test(e)), 'no numerically-shaped backup leftover');
    assert.ok(existsSync(join(dir, 'data', 'laya-venv.backup-manual', 'keep.txt')), 'operator data sharing the prefix survives');
    assert.ok(existsSync(join(dir, 'data', 'laya-venv.backup-weird.pid')), 'a non-generated suffix (dot in the tail) survives');
    // Second run with a FAILING install: rollback restores the previous environment.
    failInstall = true;
    err.length = 0;
    const out2: string[] = [];
    const code2 = await runHostSetup(['--yes'], {
      out: (s) => out2.push(s), err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code2, 1, `failing reinstall: ${err.join('')} | ${out2.join('')}`);
    assert.match(err.join(''), /pip install laya\[serve\]==[^ ]+ failed/);
    assert.ok(existsSync(installedMarker), 'the previous install survives the failed rebuild (rolled back)');
    // The staging venv is cleaned up on a pre-swap failure (Copilot #840 r48).
    assert.ok(!readdirSync(join(dir, 'data')).some((e) => e.includes('.staging-')), 'no staging venv leaks after a failed install');
    assert.ok(!readdirSync(join(dir, 'data')).some((e) => /^laya-venv\.backup-\d+$/.test(e)), 'no generated backup venv leaks after a failed install');
    // Crash recovery (Copilot #840 r58): a crash between the backup rename and a completed
    // rebuild leaves the working venv under backup-<old pid> with NO live venv. The next run
    // must ADOPT that backup so a failed rebuild rolls it back instead of leaving the unit
    // without an executable.
    const crashedBackup = join(dir, 'data', 'laya-venv.backup-424242');
    renameSync(live, crashedBackup);
    // r59 shape: the crashed run had ALSO created a partial live venv before dying — the next
    // run must prefer the WORKING numeric backup over the partial tree.
    mkdirSync(join(live, 'bin'), { recursive: true });
    writeFileSync(join(live, 'bin', 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    err.length = 0;
    const code3 = await runHostSetup(['--yes'], {
      out: () => {}, err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
    assert.equal(code3, 1, `crashed-backup rebuild must fail cleanly: ${err.join('')}`);
    assert.match(err.join(''), /pip install laya\[serve\]==[^ ]+ failed/, 'the rebuild failed at the install step');
    assert.ok(existsSync(installedMarker), 'the adopted backup was rolled back into the live path');
    assert.ok(!existsSync(crashedBackup), 'the adopted backup no longer sits under its old name');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a marker-less live venv with no backup does not wedge re-runs under real uv semantics (#840 r60)', async () => {
  const dir = tempDir('setup-laya-nomark-');
  const err: string[] = [];
  const out: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  let failInstall = false;
  // REAL uv semantics (uv 0.8): `uv venv` on an existing directory fails instead of replacing
  // it. The other tests emulate replace semantics, which is why this wedge went unseen.
  const sidecarRun = (argv: string[]) => {
    if (argv[0] === 'uv' && argv[1] === 'venv') {
      const target = argv[2]!;
      if (existsSync(target)) {
        return { ok: false, stdout: '', stderr: `error: Failed to create virtual environment\n  Caused by: A directory already exists at: ${target}` };
      }
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (argv.join(' ').includes('pip install')) {
      if (failInstall) return { ok: false, stdout: '', stderr: 'boom' };
      writeFileSync(join(dirname(argv[0]!), '.laya-installed'), 'y\n');
      return { ok: true, stdout: '', stderr: '' };
    }
    return okRun(argv);
  };
  const runOnce = (args: string[], probeUrl: string) => runHostSetup(args, {
    out: (s) => out.push(s), err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarRun, sidecarDataDir: join(dir, 'data'),
    sidecarProbeUrl: probeUrl, sidecarReadinessBudgetMs: 10_000,
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
  const live = join(dir, 'data', 'laya-venv');
  try {
    // Shape 1: a FRESH install whose pip step fails leaves a partial live tree, no marker,
    // no backup. The next run must rebuild, not fail at `uv venv` forever.
    failInstall = true;
    assert.equal(await runOnce([], fake.url), 1, 'the failing fresh install fails');
    assert.ok(existsSync(live), 'precondition: the partial tree is left at the live path');
    assert.ok(!existsSync(join(live, '.laya-install-ok')), 'precondition: no completion marker');
    failInstall = false;
    err.length = 0;
    assert.equal(await runOnce(['--yes'], fake.url), 0, `the re-run after a failed fresh install: ${err.join('')}`);
    assert.ok(existsSync(join(live, 'bin', '.laya-installed')), 'the re-run installed into the live path');

    // Shape 2: a COMPLETE venv from before the marker existed (or a failed marker write).
    rmSync(join(live, '.laya-install-ok'), { force: true });
    err.length = 0;
    assert.equal(await runOnce(['--yes'], fake.url), 0, `the re-run over a marker-less complete venv: ${err.join('')}`);
    assert.ok(existsSync(join(live, '.laya-install-ok')), 'the rebuilt venv carries the completion marker');
    assert.deepEqual(readdirSync(join(dir, 'data')).filter((e) => /^laya-venv\.backup-\d+$/.test(e)), [], 'no backup leaks after success');

    // Shape 3: the marker-less venv is still the rollback source when the rebuild fails.
    rmSync(join(live, '.laya-install-ok'), { force: true });
    failInstall = true;
    err.length = 0;
    assert.equal(await runOnce(['--yes'], fake.url), 1, 'the failing rebuild fails');
    assert.match(err.join(''), /pip install laya\[serve\]==[^ ]+ failed/, 'it failed at install, not at `uv venv`');
    assert.ok(existsSync(join(live, 'bin', '.laya-installed')), 'the marker-less previous venv was rolled back into place');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: rebuild-transaction gaps from the r61 review (#840 r61)', async () => {
  const dir = tempDir('setup-laya-r61-');
  const err: string[] = [];
  const out: string[] = [];
  const calls: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  // Real uv semantics, as in r60.
  const sidecarRun = (argv: string[]) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'uv' && argv[1] === 'venv') {
      const target = argv[2]!;
      if (existsSync(target)) return { ok: false, stdout: '', stderr: `A directory already exists at: ${target}` };
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (argv.join(' ').includes('pip install')) {
      writeFileSync(join(dirname(argv[0]!), '.laya-installed'), 'y\n');
      return { ok: true, stdout: '', stderr: '' };
    }
    return okRun(argv);
  };
  const env = { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir };
  const runOnce = (args: string[], dataDir: string, probeUrl: string, budgetMs = 10_000) => runHostSetup(args, {
    out: (s) => out.push(s), err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarRun, sidecarDataDir: dataDir,
    sidecarProbeUrl: probeUrl, sidecarReadinessBudgetMs: budgetMs,
  }, env);
  const dataA = join(dir, 'dataA');
  const dataB = join(dir, 'dataB');
  const unitPath = process.platform === 'darwin'
    ? join(dir, 'Library', 'LaunchAgents', 'com.mercury.laya.plist')
    : join(dir, 'systemd', 'user', 'com.mercury.laya.service');
  try {
    // (c) The marker means VERIFIED: a fresh install that fails readiness leaves no marker,
    // so a later run does not prefer that unverified tree over a verified backup.
    assert.equal(await runOnce([], dataA, 'http://127.0.0.1:1/v1/systemone', 2_000), 1, 'fresh install, readiness fails');
    assert.ok(existsSync(join(dataA, 'laya-venv', 'bin', '.laya-installed')), 'precondition: pip ran');
    assert.ok(!existsSync(join(dataA, 'laya-venv', '.laya-install-ok')), 'an unverified venv carries no marker');
    err.length = 0;
    assert.equal(await runOnce(['--yes'], dataA, fake.url), 0, `verified install: ${err.join('')}`);
    assert.ok(existsSync(join(dataA, 'laya-venv', '.laya-install-ok')), 'the marker lands after the doctor probe');
    const unitA = readFileSync(unitPath, 'utf8');
    assert.ok(unitA.includes(join(dataA, 'laya-venv')), 'precondition: the unit points at dataA');

    // (b) A re-run that changes dataDir and fails readiness restores the PREVIOUS unit, which
    // still points at the working venv under dataA.
    err.length = 0;
    assert.equal(await runOnce(['--yes'], dataB, 'http://127.0.0.1:1/v1/systemone', 2_000), 1, 'dataDir change, readiness fails');
    assert.equal(readFileSync(unitPath, 'utf8'), unitA, 'the previous unit is restored byte-for-byte');
    assert.ok(existsSync(join(dataA, 'laya-venv', '.laya-install-ok')), 'the old verified venv is untouched');

    // (a) An invalid MERCURY_LAYA_TIMEOUT_MS refuses BEFORE anything is moved or rebuilt.
    const envPath = envFilePath({ XDG_CONFIG_HOME: dir });
    writeFileSync(envPath, `${readFileSync(envPath, 'utf8')}MERCURY_LAYA_TIMEOUT_MS=0\n`);
    calls.length = 0;
    err.length = 0;
    assert.equal(await runOnce(['--yes'], dataA, fake.url), 1, 'invalid timeout refuses');
    assert.match(err.join(''), /MERCURY_LAYA_TIMEOUT_MS/, 'the refusal names the variable');
    assert.ok(!calls.some((c) => c.startsWith('uv venv') || c.includes('pip install')), 'nothing was rebuilt');
    assert.ok(existsSync(join(dataA, 'laya-venv', '.laya-install-ok')), 'the live venv stays in place');
    assert.deepEqual(readdirSync(dataA).filter((e) => /^laya-venv\.backup-\d+$/.test(e)), [], 'no backup venv is left behind');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a readiness failure rolls the previous venv back into place (#840 r59)', async () => {
  const dir = tempDir('setup-laya-rr-');
  const out: string[] = [];
  const err: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  let failInstall = false;
  const sidecarRun = (argv: string[]) => {
    if (failInstall && argv.join(' ').includes('pip install')) return { ok: false, stdout: '', stderr: 'boom' };
    // Real-filesystem emulation: uv-replace semantics.
    if (argv[0] === 'uv' && argv[1] === 'venv') {
      const target = argv[2];
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (argv.join(' ').includes('pip install')) {
      writeFileSync(join(dirname(argv[0]), '.laya-installed'), 'y\n');
      return { ok: true, stdout: '', stderr: '' };
    }
    return okRun(argv);
  };
  try {
    const code1 = await runHostSetup([], {
      out: (s) => out.push(s), err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 30_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code1, 0, `first install: ${err.join('')} | ${out.join('')}`);
    const live = join(dir, 'data', 'laya-venv');
    const installedMarker = join(live, 'bin', '.laya-installed');
    assert.ok(existsSync(installedMarker), 'run 1 installed the venv');
    // Run 2: the probe URL points at a closed port with a tiny budget → readiness exhausts →
    // the previous environment must be restored (Copilot #840 r59).
    const code2 = await runHostSetup(['--yes'], {
      out: (s) => out.push(s), err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone', sidecarReadinessBudgetMs: 3_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code2, 1, 'a readiness failure fails the run');
    assert.ok(existsSync(installedMarker), 'the previous venv is restored after the readiness failure');
    assert.deepEqual(readdirSync(join(dir, 'data')).filter((e) => /^laya-venv\.backup-\d+$/.test(e)), [], 'no backup leaks after the readiness rollback');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a leftover laya.state.json (interrupted uninstall) is collision evidence (#840 r48)', async () => {
  // UninstallBotService treats a remaining state file as proof of an interrupted uninstall —
  // setup must refuse the alias for that shape too, BEFORE preserving the old token as the
  // sidecar key.
  const dir = tempDir('setup-laya-state-');
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bots', 'laya.state.json'), '{}');
  const err: string[] = [];
  // A tiny readiness budget + dead probe URL keep the test FAST if the collision gate is ever
  // removed: the run then reaches the install path and fails in seconds instead of hanging.
  const code = await runHostSetup([], {
    out: () => {}, err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
  assert.equal(code, 1);
  assert.match(err.join(''), /reserved for the sidecar credential/);
  assert.match(err.join(''), /laya\.state\.json/);
});

test('ensureLayaCredentials: a loose-mode credentials file is fail-closed for the registry gate (#840 r52)', async () => {
  // 0644 + a bot-registered key: readBotCredentials refuses; the gate must fail closed instead
  // of letting ensureLayaCredentials repair the mode and preserve the Mercury token.
  const dir = tempDir('setup-laya-loose-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-legacy-laya:bot-laya\n');
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'tok-legacy-laya' } }), { mode: 0o644 });
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {}, err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
  assert.equal(code, 1);
  assert.match(err.join(''), /registry gate/);
  assert.match(err.join(''), /chmod 600/);
});

test('ensureLayaCredentials: a stale PID-named temp file is never reused (#840 r52)', () => {
  const dir = tempDir('setup-laya-tmp-reuse-');
  const credsPath = join(dir, 'mercury', 'bot-credentials.json');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  // A crashed run's leftover temp at 0644 with ANOTHER pid — must never be picked up.
  const stale = join(dir, 'mercury', '.bot-credentials.json.tmp-999999');
  writeFileSync(stale, '{"laya":{"api":"stale"}}\n', { mode: 0o644 });
  // The exposure window test: make the final rename FAIL (destination is a directory) so the
  // just-written temp file stays behind. `mode` only applies at CREATION — code that reuses a
  // predictable existing temp writes the fresh key through the STALE 0644 file; O_EXCL code
  // always writes through a fresh 0600 file.
  const samePid = join(dir, 'mercury', `.bot-credentials.json.tmp-${process.pid}`);
  writeFileSync(samePid, '{"x":1}\n', { mode: 0o644 });
  mkdirSync(credsPath); // rename over a directory fails
  const gen = () => 'a'.repeat(64);
  let threw = false;
  try {
    ensureLayaCredentials({ XDG_CONFIG_HOME: dir, HOME: dir } as NodeJS.ProcessEnv, gen);
  } catch {
    threw = true; // renameSync over a directory must fail — expected
  }
  assert.ok(threw, 'the write did not silently succeed over a directory');
  for (const entry of readdirSync(join(dir, 'mercury'))) {
    const p = join(dir, 'mercury', entry);
    if (!statSync(p).isFile()) continue;
    const content = readFileSync(p, 'utf8');
    if (!content.includes('a'.repeat(64))) continue;
    const mode = statSync(p).mode & 0o777;
    assert.equal(mode, 0o600, `${entry} carries the fresh key at mode ${mode.toString(8)} (must be 0600)`);
  }
});

test('ensureLayaCredentials: a predictable PID-shaped temp is never reused (#840 r52)', () => {
  const dir = tempDir('setup-laya-tmp-clean-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  // A crashed run's leftover occupying the predictable temp path — as a 0644 DIRECTORY for a
  // deterministic signal: the old code would collide (EISDIR on write, or write THROUGH an
  // existing file without re-applying the mode); O_EXCL creation with a unique name must not
  // collide at all.
  const samePid = join(dir, 'mercury', `.bot-credentials.json.tmp-${process.pid}`);
  mkdirSync(samePid, { recursive: true });
  writeFileSync(join(samePid, 'junk'), 'x\n', { mode: 0o644 });
  const stale = join(dir, 'mercury', '.bot-credentials.json.tmp-999999');
  writeFileSync(stale, '{"laya":{"api":"stale"}}\n', { mode: 0o644 });
  const r = ensureLayaCredentials({ XDG_CONFIG_HOME: dir, HOME: dir } as NodeJS.ProcessEnv, () => 'a'.repeat(64));
  assert.equal(r.key, 'a'.repeat(64));
  const credsPath = join(dir, 'mercury', 'bot-credentials.json');
  assert.equal(statSync(credsPath).mode & 0o777, 0o600, 'the credentials file is 0600');
  assert.equal(readFileSync(credsPath, 'utf8').includes('a'.repeat(64)), true, 'the fresh key landed');
  // The collision is swept after the fresh-file success (our own naming shape, recursive).
  assert.equal(existsSync(samePid), false, 'our pid-shaped stale temp is cleaned up');
  assert.equal(readFileSync(stale, 'utf8').includes('stale'), true, "another pid's temp is untouched");
});

test('runHostSetup: the unit temp file is created exclusively at 0600 (#840 r52)', async () => {
  // A stale `.<label>.tmp-<pid>` at 0644 must not be reused when the PID is reused.
  const dir = tempDir('setup-laya-unit-tmp-');
  // The unit path is platform-specific: launchd plist (darwin, $HOME) vs systemd user unit.
  const unitDir = process.platform === 'darwin'
    ? join(dir, 'Library', 'LaunchAgents')
    : join(dir, 'systemd', 'user'); // XDG_CONFIG_HOME is already the base
  mkdirSync(unitDir, { recursive: true });
  const stale = join(unitDir, `.com.mercury.laya.tmp-999999`);
  writeFileSync(stale, 'STALE-UNIT\n', { mode: 0o644 });
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    const live2 = join(dir, 'data', 'laya-venv');
    const sidecarRun = (argv: string[]) => {
      if (argv[0] === 'uv' && argv[1] === 'venv') {
        rmSync(argv[2]!, { recursive: true, force: true });
        mkdirSync(join(argv[2]!, 'bin'), { recursive: true });
        writeFileSync(join(argv[2]!, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
      } else if (argv.includes('pip')) {
        const venvBin = dirname(argv[0]!);
        mkdirSync(venvBin, { recursive: true });
        writeFileSync(join(venvBin, '.laya-installed'), 'ok\n');
      }
      return okRun(argv);
    };
    const err: string[] = [];
    const code = await runHostSetup(['--yes'], {
      out: () => {}, err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
    assert.equal(code, 0, `wizard failed: ${err.join('')}`);
    const unit = process.platform === 'darwin'
      ? join(unitDir, 'com.mercury.laya.plist')
      : join(unitDir, 'com.mercury.laya.service');
    assert.ok(existsSync(unit), 'the unit was written');
    assert.equal(statSync(unit).mode & 0o777, 0o600, 'the unit is 0600');
    assert.ok(readFileSync(stale, 'utf8').includes('STALE-UNIT'), 'the stale unit temp was not reused');
    assert.equal(existsSync(join(unitDir, `.com.mercury.laya.tmp-${process.pid}`)), false, 'our pid-shaped unit temp is cleaned');
    assert.equal(readdirSync(unitDir).filter((e) => e.includes('.tmp-') && e !== '.com.mercury.laya.tmp-999999').length, 0, 'no unit temp leftovers from this run');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a laya credential shared with ANY bot owner or the admin token refuses (#840 r55)', async () => {
  // A shared token authorized for BOTH Mercury and Laya is the collision the gate exists for —
  // regardless of WHICH owner the registry lists.
  for (const [label, envLine, apiValue] of [
    ['shared bot owner', 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-shared:alice\n', 'tok-shared'],
    ['admin token', 'MERCURY_PORT=3999\nMERCURY_ADMIN_TOKEN=tok-admin-shared\n', 'tok-admin-shared'],
  ] as const) {
    const dir = tempDir(`setup-laya-share-${label.includes('admin') ? 'adm' : 'bot'}-`);
    mkdirSync(join(dir, 'mercury'), { recursive: true });
    writeFileSync(join(dir, 'mercury', 'mercury.env'), envLine);
    writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: apiValue } }), { mode: 0o600 });
    const err: string[] = [];
    const code = await runHostSetup([], {
      out: () => {}, err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
    assert.equal(code, 1, `${label}: must refuse (${err.join('')})`);
    assert.match(err.join(''), /one secret authorize both services|hand the admin credential/);
  }
});

test('runHostSetup: the laya credential equal to the process-env admin token refuses (#840 r56)', async () => {
  // The resolved admin token can come from the process environment (not the old env file) —
  // the gate must compare the RESOLVED answer, not just the file's old value.
  const dir = tempDir('setup-laya-admenv-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'tok-admin-env' } }), { mode: 0o600 });
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {}, err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
  }, { ...probeStubEnv(), MERCURY_ADMIN_TOKEN: 'tok-admin-env', XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
  assert.equal(code, 1, `process-env admin match must refuse (${err.join('')})`);
  assert.match(err.join(''), /equals MERCURY_ADMIN_TOKEN/);
});

test('runHostSetup: the backup survives a unit-write failure and rolls back (#840 r56)', async () => {
  const dir = tempDir('setup-laya-unitfail-');
  const live = join(dir, 'data', 'laya-venv');
  const installedMarker = join(live, 'bin', '.laya-installed');
  const sidecarRun = (argv: string[]) => {
    if (argv[0] === 'uv' && argv[1] === 'venv') {
      rmSync(argv[2]!, { recursive: true, force: true });
      mkdirSync(join(argv[2]!, 'bin'), { recursive: true });
      writeFileSync(join(argv[2]!, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
    } else if (argv.includes('pip')) {
      const venvBin = dirname(argv[0]!);
      mkdirSync(venvBin, { recursive: true });
      writeFileSync(join(venvBin, '.laya-installed'), 'ok\n');
    }
    return okRun(argv);
  };
  // Healthy install first so a live venv exists; then make the UNIT dir read-only.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    const code = await runHostSetup([], {
      out: () => {}, err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
    assert.equal(code, 0, 'first install failed');
    assert.ok(existsSync(installedMarker), 'marker installed');
    // Make the macOS unit dir read-only so the unit temp write fails AFTER the venv rebuild.
    const unitDir = process.platform === 'darwin'
      ? join(dir, 'Library', 'LaunchAgents')
      : join(dir, 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    chmodSync(unitDir, 0o555);
    const err: string[] = [];
    try {
      const code2 = await runHostSetup(['--yes'], {
        out: () => {}, err: (s) => err.push(s),
        question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
        sidecarRun, sidecarDataDir: join(dir, 'data'),
        sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
      }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
      assert.equal(code2, 1, `unit-write failure must fail the run: ${err.join('')}`);
      assert.match(err.join(''), /not installed/);
      // Rollback restored the previous environment: the installed marker is intact.
      assert.ok(existsSync(installedMarker), 'the previous install survives a unit-write failure');
      // And no generated backup venv leaks after the rollback.
      assert.ok(!readdirSync(join(dir, 'data')).some((e) => /^laya-venv\.backup-\d+$/.test(e)), 'no backup leak');
    } finally {
      chmodSync(unitDir, 0o755);
    }
  } finally {
    await fake.close();
  }
});

test('registeredLayaOwner: trims both halves and skips malformed entries (#840 r54)', () => {
  assert.equal(registeredLayaOwner('tok-legacy-laya: bot-laya', 'tok-legacy-laya'), 'bot-laya');
  assert.equal(registeredLayaOwner('tok-legacy-laya :bot-laya', 'tok-legacy-laya'), 'bot-laya');
  assert.equal(registeredLayaOwner('a:alice,tok-legacy-laya:bot-laya', 'tok-legacy-laya'), 'bot-laya');
  assert.equal(registeredLayaOwner('tok-legacy-laya:alice', 'tok-legacy-laya'), 'alice');
  assert.equal(registeredLayaOwner('malformed-entry', 'tok-legacy-laya'), null);
  assert.equal(registeredLayaOwner('other:bot-laya', 'tok-legacy-laya'), null);
  assert.equal(registeredLayaOwner('', 'tok-legacy-laya'), null);
});

test('runHostSetup: a laya credential still registered as bot-laya in MERCURY_API_TOKENS refuses (interrupted uninstall, #840 r51)', async () => {
  // The interrupted-uninstall window: unit/state/config already removed, but the credential
  // entry AND the token:bot-laya registration survive. Preserving that value as the sidecar
  // key would authorize one secret for both the Mercury API and Laya — refuse instead.
  const dir = tempDir('setup-laya-reg-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-alice:alice,tok-legacy-laya:bot-laya\n');
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'tok-legacy-laya' } }), { mode: 0o600 });
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {}, err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
  assert.equal(code, 1);
  assert.match(err.join(''), /interrupted/);
  assert.match(err.join(''), /owner 'bot-laya' in MERCURY_API_TOKENS/);
  // r54: whitespace around either half of the entry is a valid registration (parseTokens trims)
  // — the gate must stay fail-closed for the hand-written shape too.
  const dirWs = tempDir('setup-laya-reg-ws-');
  mkdirSync(join(dirWs, 'mercury'), { recursive: true });
  writeFileSync(join(dirWs, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-legacy-laya: bot-laya\n');
  writeFileSync(join(dirWs, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'tok-legacy-laya' } }), { mode: 0o600 });
  const errWs: string[] = [];
  // Setup refuses the spaced entry at the safe-charset gate (a space is outside the value
  // charset — it throws before anything is written) — fail-closed either way; the registry
  // comparison itself also trims (parseTokens parity) so the gate cannot be slipped by a
  // differently-sourced registry.
  await assert.rejects(
    () => runHostSetup([], {
      out: () => {}, err: (s) => errWs.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarReadinessBudgetMs: 2_000, sidecarProbeUrl: 'http://127.0.0.1:1/v1/systemone',
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dirWs, XDG_STATE_HOME: dirWs, HOME: dirWs }),
    /safe charset/,
  );
  // A sidecar key that is NOT bot-registered does not trip the gate (the normal re-run path).
  const dir2 = tempDir('setup-laya-reg2-');
  mkdirSync(join(dir2, 'mercury'), { recursive: true });
  writeFileSync(join(dir2, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_API_TOKENS=tok-alice:alice\n');
  writeFileSync(join(dir2, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'k'.repeat(32) } }), { mode: 0o600 });
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    const err2: string[] = [];
    const out2: string[] = [];
    // Scripted sidecar exec (same shape as the r47 staging test) — no real uv/systemd on CI.
    const live2 = join(dir2, 'data', 'laya-venv');
    const sidecarRun2 = (argv: string[]) => {
      if (argv[0] === 'uv' && argv[1] === 'venv') {
        rmSync(argv[2]!, { recursive: true, force: true });
        mkdirSync(join(argv[2]!, 'bin'), { recursive: true });
        writeFileSync(join(argv[2]!, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
      } else if (argv.includes('pip')) {
        const venvBin = dirname(argv[0]!);
        mkdirSync(venvBin, { recursive: true });
        writeFileSync(join(venvBin, '.laya-installed'), 'ok\n');
      } else if (argv[0] === 'systemctl') {
        // Emulate enable/restart success: the unit file must exist by then.
        mkdirSync(dirname(live2), { recursive: true });
      }
      return okRun(argv);
    };
    const code2 = await runHostSetup(['--yes'], {
      out: (s) => out2.push(s), err: (s) => err2.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: sidecarRun2, sidecarDataDir: join(dir2, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir2, XDG_STATE_HOME: dir2, HOME: dir2 });
    assert.equal(code2, 0, `unregistered sidecar key passes: ERR=${JSON.stringify(err2.join(''))} OUT=${JSON.stringify(out2.join('').slice(-300))}`);
    assert.ok(!err2.join('').includes('bot-laya'), 'the gate does not fire for an unregistered key');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: collision evidence covers the lifecycle homedir() unit resolution (#840 r48)', () => {
  // botPlistPath WRITES under homedir() while the wizard's env may carry a different $HOME —
  // both resolutions must be checked so neither shape hides the real unit.
  const dir = tempDir('setup-laya-bots-');
  const proc = join(dir, 'proc-home');
  const ioHome = join(dir, 'io-home');
  mkdirSync(join(proc, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(proc, 'Library', 'LaunchAgents', 'com.mercury.bot.laya.plist'), 'x');
  const oldHome = process.env.HOME;
  process.env.HOME = proc; // os.homedir() follows $HOME on POSIX
  try {
    const evidence = layaCollisionEvidence({ HOME: ioHome, XDG_CONFIG_HOME: join(dir, 'cfg') });
    assert.ok(evidence.some((p) => p.startsWith(proc)), `the homedir()-resolved plist is evidence: ${JSON.stringify(evidence)}`);
    assert.ok(evidence.every((p) => !p.startsWith(ioHome)), 'the (absent) $HOME-resolved plist is not claimed');
  } finally {
    process.env.HOME = oldHome;
  }
});


test('runHostSetup: a PADDED MERCURY_LAYA_URL is refused like loadConfig/doctor (#840 r37)', async () => {
  // The env value reaches validateAnswers RAW: trimming in defaultAnswers would let setup
  // accept (and rewrite) a value the config loader and doctor refuse.
  const dir = tempDir('setup-laya-padded-');
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: () => {},
    err: (s) => err.push(s),
    question: async () => '',
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_URL: ' http://127.0.0.1:8302 ' });
  assert.equal(code, 1);
  assert.match(err.join(''), /must not have leading or trailing whitespace/);
  assert.ok(!existsSync(join(dir, 'mercury', 'mercury.env')), 'nothing written');
});

test('runHostSetup: an EXTERNAL MERCURY_LAYA_URL is preserved and verified, not replaced (#840 r21)', async () => {
  const dir = tempDir('setup-laya-ext-');
  // External endpoint with a READABLE credential (r27: a missing/unreadable entry is a named
  // failure, doctor parity) — the fake requires exactly that bearer key.
  const KEY = 'k'.repeat(32);
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: KEY } }), { mode: 0o600 });
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: KEY });
  const outx: string[] = [];
  const errx: string[] = [];
  try {
    const code = await runHostSetup([], {
      out: (s) => outx.push(s),
      err: (s) => errx.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, MERCURY_LAYA_URL: `${fake.url}` });
    assert.equal(code, 0, `setup failed: ${errx.join('')} | out: ${outx.join('')}`);
    const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
    assert.ok(file.includes(`MERCURY_LAYA_URL=${fake.url}`), 'the external URL survives verbatim');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'no local sidecar is installed over an external endpoint');
    assert.ok(!existsSync(join(dir, 'Library', 'LaunchAgents', 'com.mercury.laya.plist')), 'no unit is written (darwin check)');
    assert.ok(outx.join('').includes('external endpoint'), `the operator is told: ${outx.join('')}`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: an external URL WITHOUT laya credentials fails like the doctor (auth cannot be checked) (#840 r27)', async () => {
  const dir = tempDir('setup-laya-nokey-');
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], {}); // auth-off: a key-less probe would 200
  const outx: string[] = [];
  const errx: string[] = [];
  try {
    const code = await runHostSetup([], {
      out: (s) => outx.push(s),
      err: (s) => errx.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, MERCURY_LAYA_URL: `${fake.url}` });
    assert.equal(code, 1, `must refuse: ${outx.join('')} | ${errx.join('')}`);
    assert.match(errx.join(''), /auth cannot be checked/);
    assert.equal(fake.received.length, 0, 'no probe is sent without a key');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'nothing installed');
  } finally {
    await fake.close();
  }
});

test('validateAnswer: layaUrl must be a loopback BASE URL without a route (#840 r22)', () => {
  const bad: Array<[string, string]> = [
    ['http://', 'absolute URL'],
    ['http://192.168.1.20:8302', 'loopback host'],
    ['http://host:8302/v1/systemone', 'route path'],
    ['https://127.0.0.1:8302', 'http scheme'],
    ['http://127.0.0.1:8302/x?y=1', 'query'],
    ['http://127.0.0.1:8302?', 'bare query delimiter (#840 r44)'],
    ['http://127.0.0.1:8302#', 'bare fragment delimiter (#840 r44)'],
  ];
  for (const [url, why] of bad) {
    const err = validateAnswer('layaUrl', url);
    assert.ok(err, `${url} refused (${why})`);
  }
  // r44: bare delimiters are NAMED as query/fragment by the shared validator, not refused by a
  // charset accident (mutation: includes-check removed -> these fail).
  assert.match(validateAnswer('layaUrl', 'http://127.0.0.1:8302?') ?? '', /query or fragment/);
  assert.match(validateAnswer('layaUrl', 'http://127.0.0.1:8302#') ?? '', /query or fragment/);
  // r44: the root-path form IS valid (the wizard-managed default classifies canonically).
  assert.equal(validateAnswer('layaUrl', 'http://127.0.0.1:8302/'), null);
  // r45: localhost is a documented EXTERNAL form — accepted, but never wizard-managed.
  assert.equal(validateAnswer('layaUrl', 'http://localhost:8302'), null);
  assert.equal(isWizardManagedLayaDefault('http://localhost:8302', 8302), false, 'localhost = external');
  assert.equal(isWizardManagedLayaDefault('http://127.0.0.1:8302/', 8302), true, 'numeric root-path = wizard-managed');
  assert.match(validateAnswer('layaUrl', 'http://') ?? '', /absolute URL/);
  assert.match(validateAnswer('layaUrl', 'http://192.168.1.20:8302') ?? '', /loopback host/);
  assert.match(validateAnswer('layaUrl', 'http://host:8302/v1/systemone') ?? '', /(loopback host|without a route path)/);
  assert.equal(validateAnswer('layaUrl', 'http://127.0.0.1:8302'), null);
  assert.equal(validateAnswer('layaUrl', 'http://localhost:9000'), null);
  // r24: '::1' is NOT accepted — the bracketed literal fails the charset gate later, so the
  // message must not advertise it.
  assert.match(validateAnswer('layaUrl', 'http://[::1]:8302') ?? '', /loopback host \(127\.0\.0\.1 or localhost\)/);
  assert.equal(validateAnswer('layaUrl', ''), null);
  // r23: URL-only contract — an embedded user:password would be written to the env file and
  // printed by the external/dry-run paths.
  // r25: whitespace-only is not the empty sentinel, and padded URLs fail at render time —
  // both are refused at the gate.
  assert.match(validateAnswer('layaUrl', '   ') ?? '', /must not have leading or trailing whitespace/);
  assert.match(validateAnswer('layaUrl', '  http://127.0.0.1:9000  ') ?? '', /must not have leading or trailing whitespace/);
  const userinfo = validateAnswer('layaUrl', 'http://user:secret@127.0.0.1:8302');
  assert.match(userinfo ?? '', /must not contain a username or password/);
  assert.ok(!(userinfo ?? '').includes('secret'), 'the credential is never echoed');
});

test('validateLayaBaseUrl: a route-path error does not echo the pathname (#840 r53)', () => {
  // URL paths commonly carry credential-looking segments; the rejection must name the rule,
  // never copy the value into setup/doctor/startup output.
  const err = validateAnswer('layaUrl', 'http://127.0.0.1:8302/secret-token-123') ?? '';
  assert.match(err, /without a route path/);
  assert.ok(!err.includes('secret-token-123'), `the pathname leaked: ${err}`);
});

test('readiness: an anon probe TIMEOUT whose detail contains 401 is not auth proof (#840 r53)', async () => {
  // MERCURY_LAYA_TIMEOUT_MS=401 (an allowed value): a slow anon probe yields
  // 'unreachable: deadline 401ms exceeded' — the old 'detail.includes("401")' check took that
  // as auth proven. Only the normalized 'auth failed (401)' verdict proves auth.
  const dir = tempDir('setup-laya-t401-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\nMERCURY_LAYA_TIMEOUT_MS=401\n');
  // Anon (bearer-less) requests never answer inside the 401 ms deadline; the AUTHENTICATED
  // probe answers fine (the wizard's key matches) — so the flow reaches the anon auth-proof
  // loop, where a hanging probe must stay INCONCLUSIVE.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*', anonScript: [{ delayMs: 3_000 }] });
  try {
    const err: string[] = [];
    // Scripted sidecar exec (same shape as the r47 staging test) — CI has no real uv/python.
    const sidecarRun = (argv: string[]) => {
      if (argv[0] === 'uv' && argv[1] === 'venv') {
        rmSync(argv[2]!, { recursive: true, force: true });
        mkdirSync(join(argv[2]!, 'bin'), { recursive: true });
        writeFileSync(join(argv[2]!, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
      } else if (argv.includes('pip')) {
        const venvBin = dirname(argv[0]!);
        mkdirSync(venvBin, { recursive: true });
        writeFileSync(join(venvBin, '.laya-installed'), 'ok\n');
      }
      return okRun(argv);
    };
    const code = await runHostSetup(['--yes'], {
      out: () => {}, err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun, sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`, sidecarReadinessBudgetMs: 4_000, sidecarReadinessGapMs: 50,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, HOME: dir });
    assert.equal(code, 1, `a 401-shaped timeout must not pass: ${err.join('')}`);
    assert.match(err.join(''), /readiness budget ran out while proving auth/);
    assert.match(err.join(''), /deadline \d+ms exceeded/);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: the external probe uses the laya credential, exactly like the doctor (#840 r22)', () => {
  // The fake requires the REAL key; setup must read it from the seeded credentials file (the
  // doctor's resolution) — a key-less probe would 401 and fail the run.
  const dir = tempDir('setup-laya-extauth-');
  const fake = startFakeLaya([{ json: validPick(['probe']) }], { apiKey: 'k'.repeat(32) });
  // seed credentials BEFORE the run so setup resolves the same key the doctor would.
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'k'.repeat(32) } }), { mode: 0o600 });
  const outx: string[] = [];
  const errx: string[] = [];
  return fake.then(async (f) => {
    try {
      const code = await runHostSetup([], {
        out: (s) => outx.push(s),
        err: (s) => errx.push(s),
        question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
        sidecarRun: okRun,
        sidecarDataDir: join(dir, 'data'),
        sidecarProbeUrl: `${f.url}`,
        sidecarReadinessBudgetMs: 10_000,
      }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, MERCURY_LAYA_URL: `${f.url}` });
      assert.equal(code, 0, `authed external probe: ${errx.join('')}`);
      assert.ok(f.received.length >= 1);
      assert.ok(f.received[0]!.headers.authorization === `Bearer ${'k'.repeat(32)}`, 'the probe carries the credential');
    } finally {
      await f.close();
    }
  });
});

test('runHostSetup: an INVALID layaUrl in the answers file is rejected, not defaulted (#840 r23)', async () => {
  const dir = tempDir('setup-laya-badurl-');
  const answersFile = join(dir, 'answers.json');
  // A number where the URL belongs: normalizing it to the wizard default would install a local
  // sidecar over the operator's malformed endpoint instead of refusing.
  writeFileSync(answersFile, JSON.stringify({ layaEnabled: true, layaUrl: 8302 }));
  const err: string[] = [];
  const code = await runHostSetup(['--non-interactive', '--yes', '--answers', answersFile], {
    out: () => {},
    err: (s) => err.push(s),
    question: async () => '',
    sidecarRun: okRun,
    sidecarDataDir: join(dir, 'data'),
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 1);
  assert.match(err.join(''), /layaUrl: layaUrl must be a string/);
  assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'nothing installed');
});

test('validateAnswers: a NON-STRING dataDir with the Laya sidecar enabled is reported, not thrown (#840 r29)', () => {
  // The cross-field absolute-path check must not .trim() a non-string: validateAnswer already
  // reports the type error and the run must exit 1 normally, not crash.
  const a = answers({ layaEnabled: true, dataDir: 123 as unknown as string });
  const errs = validateAnswers(a);
  assert.ok(errs.some((e) => e.startsWith('dataDir:') && e.includes('path must not be empty')), `type error reported: ${errs.join(' | ')}`);
});

test('runHostSetup: an EXTERNAL url with a pre-existing laya bot is refused before probing (#840 r33)', async () => {
  // The external path reads the shared credential entry as the sidecar key; with a pre-existing
  // bot 'laya' that entry is a MERCURY token. The collision must be refused before any branch —
  // no probe, no venv.
  const dir = tempDir('setup-laya-extbot-');
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bots', 'laya.json'), JSON.stringify({ alias: 'laya', api: {}, tasks: [] }));
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'k'.repeat(32) } }), { mode: 0o600 });
  const err: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: 'k'.repeat(32) });
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_URL: `${fake.url}` });
    assert.equal(code, 1);
    assert.match(err.join(''), /reserved for the sidecar credential/);
    assert.equal(fake.received.length, 0, 'no probe carries the bot token');
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'nothing installed');
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a legacy laya SERVICE UNIT (config moved) is collision evidence too (#840 r43)', async () => {
  const dir = tempDir('setup-laya-unitbot-');
  if (process.platform !== 'darwin') {
    // The unit evidence path is darwin-launchd here; linux systemd evidence is exercised in CI.
    return;
  }
  mkdirSync(join(dir, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(dir, 'Library', 'LaunchAgents', 'com.mercury.bot.laya.plist'), '<plist/>');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'k'.repeat(32) } }), { mode: 0o600 });
  const err: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: 'k'.repeat(32) });
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_URL: `${fake.url}` });
    assert.equal(code, 1);
    assert.match(err.join(''), /reserved for the sidecar credential/);
    assert.equal(fake.received.length, 0, 'no probe carries the bot token');
  } finally {
    await fake.close();
  }
});

test('ensureLayaCredentials: a bot named laya refuses the sidecar credential write (#840 r31)', async () => {
  const dir = tempDir('setup-laya-alias-');
  // An existing bot 'laya' holds its MERCURY API token in the shared entry; setup must not
  // repurpose it as the sidecar key (and uninstall would later delete it).
  mkdirSync(join(dir, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bots', 'laya.json'), JSON.stringify({ alias: 'laya', api: {}, tasks: [] }));
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ laya: { api: 'k'.repeat(32) } }), { mode: 0o600 });
  const err: string[] = [];
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], {});
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 1);
    assert.match(err.join(''), /reserved for the sidecar credential/);
    assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'nothing installed');
    // r41: the refusal happens BEFORE mercury.env is written — a persisted MERCURY_LAYA_URL
    // would make doctor send the bot's Mercury token to the port owner.
    assert.ok(!existsSync(envFilePath({ XDG_CONFIG_HOME: dir })), 'no env file written before the refusal');
  } finally {
    await fake.close();
  }
});

test('validateAnswers: the ROOT-PATH default URL is wizard-managed, not external (#840 r44)', () => {
  // 'http://127.0.0.1:8302/' parses to the local default; a relative dataDir must still be
  // refused (the raw-string compare classified it external and skipped the gate).
  const errs = validateAnswers(answers({ layaEnabled: true, dataDir: 'data', layaUrl: 'http://127.0.0.1:8302/' }));
  assert.ok(errs.some((e) => e.includes('absolute path')), `root-path form is local: ${errs.join(' | ')}`);
});

test('validateAnswers: a relative dataDir with the Laya sidecar enabled is refused (#840 r25)', () => {
  // systemd ExecStart rejects relative executables; the unit embeds venv/serve paths derived
  // from the data dir, so an opt-in Laya requires an absolute data dir.
  const a = answers({ layaEnabled: true, dataDir: 'data' });
  const errs = validateAnswers(a);
  assert.ok(errs.some((e) => e.includes('dataDir') && e.includes('absolute path')), `relative dataDir refused: ${errs.join(' | ')}`);
  assert.equal(validateAnswers(answers({ layaEnabled: true, dataDir: '/var/lib/mercury' })).length, 0, 'absolute passes');
  // r31: an external URL installs nothing — a relative dataDir stays valid for the host.
  assert.equal(validateAnswers(answers({ layaEnabled: true, dataDir: 'data', layaUrl: 'http://localhost:9000' })).length, 0, 'external + relative passes');
});

test('runHostSetup --dry-run: an external URL prints preserve/verify only, no install actions (#840 r22)', async () => {
  const dir = tempDir('setup-laya-dryext-');
  const out: string[] = [];
  let execCalls = 0;
  const code = await runHostSetup(['--dry-run'], {
    out: (s) => out.push(s),
    err: () => {},
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarRun: (argv) => { execCalls += 1; return okRun(argv); },
    sidecarDataDir: join(dir, 'data'),
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, MERCURY_LAYA_URL: 'http://127.0.0.1:9000' });
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /external.*preserve MERCURY_LAYA_URL=http:\/\/127\.0\.0\.1:9000.*verify it with the doctor probe/s, `external plan: ${text}`);
  assert.ok(!text.includes('create venv'), 'no venv action for an external endpoint');
  assert.ok(!text.includes('write unit'), 'no unit action for an external endpoint');
  assert.equal(execCalls, 0, 'dry-run executes nothing');
});

test('runHostSetup: the readiness gate REQUIRES auth — an open sidecar on the port is refused (#840 r21)', async () => {
  const dir = tempDir('setup-laya-open-');
  // auth OFF: the fake answers every request. The unit embeds a key, so an answering-but-open
  // port means ANOTHER service owns it — setup must refuse, not report ok.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], {});
  const err: string[] = [];
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 1);
    assert.ok(err.join('').includes('answers WITHOUT a key'), `named failure: ${err.join('')}`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: an authed 401 during readiness is a port conflict, not a retry (#840 r32)', async () => {
  // Another auth-enabled sidecar (fixed key ≠ the wizard's) owns 8302: the authed probe gets a
  // definitive 401 — setup must fail immediately with the conflict, not retry for the budget.
  const dir = tempDir('setup-laya-conflict-');
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: 'other-service-key'.padEnd(32, 'x') });
  const err: string[] = [];
  const t0 = Date.now();
  try {
    const code = await runHostSetup([], {
      out: () => {},
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 20_000,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    const elapsed = Date.now() - t0;
    assert.equal(code, 1);
    assert.match(err.join(''), /another auth-enabled sidecar owns the port/, `named conflict: ${err.join('')}`);
    assert.ok(elapsed < 10_000, `fails fast: ${elapsed} ms`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: a transient anonymous-probe failure is retried, not read as open auth (#840 r28)', async () => {
  // Authed probe 200 (auth on), anon probe 503 (inconclusive blip), retry → 401 → proven.
  // Before r28 the 503 was read as "answers WITHOUT a key" and killed a healthy install.
  const dir = tempDir('setup-laya-anon503-');
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*', anonScript: [{ status: 503, json: { error: 'overloaded' } }, { status: 401, json: { error: 'unauthorized' } }] });
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await runHostSetup([], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 10_000,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 0, `setup must recover: ${err.join('')} | ${out.join('')}`);
    assert.ok(out.join('').includes('doctor ok'), `success reported: ${out.join('')}`);
    // r30: the success line reports the AUTHENTICATED probe's detail, not a stale anon blip.
    const okLine = out.join('').split('\n').find((l) => l.includes('doctor ok')) ?? '';
    assert.doesNotMatch(okLine, /503/, `no stale anon detail: ${okLine}`);
    assert.match(okLine, /doctor ok — ok, checkpoint/, `authed detail printed: ${okLine}`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: the readiness budget bounds a huge MERCURY_LAYA_TIMEOUT_MS (#840 r21)', async () => {
  const dir = tempDir('setup-laya-budget-');
  const fake = await startFakeLaya([{ hang: true }], { apiKey: '*' });
  const t0 = Date.now();
  try {
    // timeout 600000 (10 min/probe) + budget 2 s: the probe deadline must cap to the remaining
    // budget — setup exits ~2 s in, not 20 hours.
    const code = await runHostSetup([], {
      out: () => {},
      err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessBudgetMs: 2_000,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir, MERCURY_LAYA_TIMEOUT_MS: '600000' });
    const elapsed = Date.now() - t0;
    assert.equal(code, 1);
    assert.ok(elapsed < 15_000, `the budget bounds the wait: ${elapsed} ms`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: the readiness window retries until the sidecar answers (#840 r11)', async () => {
  // A fresh sidecar downloads the English checkpoint first; the first probes legitimately
  // fail. The wizard must keep probing within its bounded window, not exit 1.
  const dir = tempDir('setup-laya-ready-');
  const fake = await startFakeLaya([{ hang: true }, { json: validPick(['probe']) }], { apiKey: '*' });
  const out: string[] = [];
  try {
    const code = await runHostSetup([], {
      out: (s) => out.push(s),
      err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
    sidecarProbeUrl: `${fake.url}`,
      sidecarReadinessGapMs: 20,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code, 0, `setup failed: ${out.join('')}`);
    assert.ok(out.join('').includes('laya: doctor ok'), `probe eventually green: ${out.join('')}`);
    assert.ok(fake.received.length >= 2, `retried after the first refusal (${fake.received.length} probes)`);
  } finally {
    await fake.close();
  }
});

test('runHostSetup: laya interpreter refusal fails the step AFTER mercury.env is written (#831)', async () => {
  const dir = tempDir('setup-laya-oldpy-');
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostSetup([], {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarRun: (argv) => (argv[0] === 'uv' ? { ok: false, stdout: '', stderr: 'no' } : { ok: true, stdout: 'Python 3.9.6', stderr: '' }),
    sidecarDataDir: join(dir, 'data'),
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 1);
  // Wording is platform-specific by design (the acceptance names the macOS system python);
  // the darwin-specific wording is pinned separately in the detectPython tests, which inject
  // the platform. Here accept either so the suite runs on the Ubuntu CI jobs too.
  assert.match(err.join(''), /(system Python on macOS is too old|python too old)/);
  const file = readFileSync(envFilePath({ XDG_CONFIG_HOME: dir }), 'utf8');
  assert.ok(file.includes('MERCURY_ADMIN_TOKEN'), 'mercury.env itself is written before the step fails');
  assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'no venv is created when the interpreter is refused');
});

test('ensureLayaCredentials + unit write: a pre-existing loose unit file is repaired to 0600 (#840 r1)', async () => {
  // The unit embeds the API key; the re-run must not leave it world-readable. The unit path is
  // platform-specific (launchd plist vs systemd user unit) — build it with the plan's own
  // rule so the Ubuntu CI job seeds and asserts the SAME file setup writes.
  const dir = tempDir('setup-laya-unitmode-');
  const unitPath = process.platform === 'darwin'
    ? join(dir, 'Library', 'LaunchAgents', 'com.mercury.laya.plist')
    : join(dir, 'systemd', 'user', 'com.mercury.laya.service');
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, 'stale', { mode: 0o644 });
  // The run now LOADS the unit and probes it (r10/r11): a fake sidecar answers on the fixed
  // port; the readiness window is shrunk to keep the test fast.
  const fake = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
  try {
    await runHostSetup([], {
      out: () => {},
      err: () => {},
      question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
      sidecarRun: okRun,
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
  sidecarProbeUrl: `${fake.url}`,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
  } finally {
    await fake.close();
  }
  assert.equal((statSync(unitPath).mode & 0o777).toString(8), '600', 'the rewritten unit must be 0600');
  // r15: the secret-bearing unit goes through 0600 temp + rename — no temp file may remain.
  const leftovers = readdirSync(join(unitPath, '..')).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `no unit temp file remains: ${leftovers.join(', ')}`);
  // Linux r11: after enable --now the unit is RESTARTED so a rewritten unit/key takes effect.
  // (Darwin runs kickstart instead; the restart branch is exercised on the Ubuntu CI job.)
  if (process.platform === 'linux') {
    // re-run the setup once more to prove the FULL systemctl order (r13): daemon-reload first
    // (a fresh unit is invisible to enable until then), then enable, then restart.
    const calls: string[][] = [];
    const fake2 = await startFakeLaya([{ json: validPick(['probe']) }], { apiKey: '*' });
    try {
      await runHostSetup(['--yes'], {
        out: () => {},
        err: () => {},
        question: async () => '',
        sidecarRun: (argv: string[]) => {
          calls.push(argv);
          return okRun(argv);
        },
        sidecarDataDir: join(dir, 'data'),
        sidecarReadinessBudgetMs: 30_000,
        sidecarProbeUrl: `${fake2.url}`,
      }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    } finally {
      await fake2.close();
    }
    const sys = calls.filter((a) => a[0] === 'systemctl').map((a) => a[2]);
    assert.deepEqual(sys, ['daemon-reload', 'enable', 'restart'], `systemctl order: ${calls.map((c) => c.join(' ')).join(' | ')}`);
    // A failed enable must exit 1 IMMEDIATELY, not wait through the readiness window.
    const err2: string[] = [];
    const code2 = await runHostSetup(['--yes'], {
      out: () => {},
      err: (s) => err2.push(s),
      question: async () => '',
      sidecarRun: (argv: string[]) =>
        argv[0] === 'systemctl' && argv[2] === 'enable'
          ? { ok: false, stdout: '', stderr: 'Unit com.mercury.laya.service not found' }
          : okRun(argv),
      sidecarDataDir: join(dir, 'data'),
      sidecarReadinessBudgetMs: 30_000,
      sidecarProbeUrl: `${fake2.url}`,
      sidecarReadinessGapMs: 10,
    }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir, HOME: dir });
    assert.equal(code2, 1, 'a failed enable exits 1');
    assert.ok(err2.join('').includes('systemctl enable failed'), `named failure: ${err2.join('')}`);
  }
});

test('defaultAnswers: MERCURY_LAYA_URL in the EXISTING mercury.env keeps the sidecar enabled (#840 r1)', () => {
  const dir = tempDir('laya-default-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'mercury.env'), 'MERCURY_LAYA_URL=http://127.0.0.1:8302\n');
  const base = defaultAnswers({ ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(base.layaEnabled, true, 'a re-run from a plain shell must not silently disable the sidecar');
  const fresh = defaultAnswers({ ...probeStubEnv(), XDG_CONFIG_HOME: tempDir('laya-fresh-') });
  assert.equal(fresh.layaEnabled, false, 'a fresh host defaults to NO');
});

test('answers file: layaEnabled must be a boolean, not a truthy string (#840 r1)', () => {
  const dir = tempDir('laya-answers-');
  const p = join(dir, 'answers.json');
  writeFileSync(p, JSON.stringify({ harnesses: ['primeagent'], layaEnabled: 'false' }));
  // The REAL path: readAnswersFile feeds validateAnswers (as runHostSetup does), so a truthy
  // string must fail validation before anything is written.
  const answers = readAnswersFile(p, probeStubEnv());
  const errors = validateAnswers(answers);
  assert.ok(errors.some((e) => e.includes('layaEnabled must be a boolean')), `got: ${errors.join('; ')}`);
});

test('runHostSetup --dry-run: laya plan printed, nothing executed (#831)', async () => {
  const dir = tempDir('setup-laya-dry-');
  const out: string[] = [];
  let execCalls = 0;
  const code = await runHostSetup(['--dry-run'], {
    out: (s) => out.push(s),
    err: () => {},
    question: async (q) => (q.includes('Laya sidecar') ? 'yes' : ''),
    sidecarRun: (argv) => { execCalls += 1; return okRun(argv); },
    sidecarDataDir: join(dir, 'data'),
  }, { ...probeStubEnv(), XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /Laya sidecar \(opt-in\) would:/);
  assert.match(text, new RegExp(`laya\\[serve\\]==${LAYA_SERVE_PIN}`));
  // The non-executing plan names BOTH venv branches and the credentials step (Copilot r5).
  assert.match(text, /when uv is present\) OR python3 -m venv/);
  assert.match(text, /generate\/keep LAYA_API_KEY/);
  // r18: the plan warns the operator that setup LOADS the agent (platform-specific command)
  // and waits for readiness before the doctor verification.
  assert.match(text, /load agent: (launchctl print\/bootout|systemctl --user daemon-reload)/, `load step in the plan: ${text}`);
  assert.match(text, /wait for readiness: probe the doctor's laya line/);
  assert.ok(!existsSync(join(dir, 'data', 'laya-venv')), 'dry-run creates no venv');
});
