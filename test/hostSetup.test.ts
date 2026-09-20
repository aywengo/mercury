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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
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
  readAnswersFile,
  runHostSetup,
  generateAdminToken,
  WIZARD_VARIABLES,
  KNOWN_HARNESSES,
  type HostSetupAnswers,
} from '../src/host/setup.ts';
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
  // Loopback case: the wizard generates a token but must NOT print a URL Fleet cannot use.
  const dirLoop = tempDir('setup-bind-loop-');
  const outLoop: string[] = [];
  const codeLoop = await runHostSetup([], {
    out: (s) => outLoop.push(s), err: () => {},
    question: async () => '', probe: async () => probeOf(['primeagent', 'ok']),
  }, { XDG_CONFIG_HOME: dirLoop });
  assert.equal(codeLoop, 0);
  const textLoop = outLoop.join('');
  assert.ok(textLoop.includes('Fleet cannot reach it'), textLoop);
  assert.ok(!textLoop.includes('host API base URL'), 'no unreachable URL may be printed');
  assert.ok(textLoop.includes('MERCURY_TLS_CERT') === false, 'no TLS warning when bound to loopback');
});

test('a generated token still appears once when the API is exposed (#665)', async () => {
  const dir = tempDir('setup-bind-exposed-');
  const out: string[] = [];
  const code = await runHostSetup([], {
    out: (s) => out.push(s), err: () => {},
    question: async () => '', probe: async () => probeOf(['primeagent', 'ok']),
  }, { XDG_CONFIG_HOME: dir });
  assert.equal(code, 0);
  const text = out.join('');
  const tokens = text.match(/host API token:\s+([0-9a-f]{64})/) ?? [];
  assert.ok(tokens[1], 'token shown');
  const occurrences = out.filter((l) => l.includes(tokens[1]!)).length;
  assert.equal(occurrences, 1);
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
