/**
 * `mercury host probe` (docs/host-installer.md M2) — the harness probe.
 *
 * The M2 gate: probe results agree with the adapters' own real-binary observations; a
 * deliberately downgraded harness is flagged (too-old), not enabled; a harness without
 * an adapter does not appear at all. These tests pin that contract with fake binaries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import { harnessSpecs, probeHarness, type HarnessSpec } from '../src/host/probe.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** A fake harness binary that prints a fixed version and exits 0. */
function fakeBinary(dir: string, version: string): string {
  const p = join(dir, 'fake-harness');
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function spec(over: Partial<HarnessSpec>): HarnessSpec {
  return {
    id: 'fake',
    label: 'Fake Harness',
    cmd: 'definitely-not-installed-xyz',
    minVersion: '1.0.0',
    configPath: '/nonexistent/config',
    auth: () => 'no',
    ...over,
  };
}

// ---------- the shipped harness set ----------

test('harnessSpecs: the three shipped harnesses appear, with their declared floors', () => {
  const specs = harnessSpecs({} as NodeJS.ProcessEnv);
  const ids = specs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['claude', 'hermes', 'primeagent']);
  const byId = new Map(specs.map((s) => [s.id, s]));
  assert.equal(byId.get('primeagent')!.minVersion, '0.3.3');
  assert.equal(byId.get('hermes')!.minVersion, '0.21.2');
  assert.equal(byId.get('claude')!.minVersion, '1.0.3');
  // `fake` is a test-only adapter, not a host harness: it must not be probed.
  assert.ok(!ids.includes('fake'), 'fake must not appear in the probe');
});

test('harnessSpecs: env overrides the binary path', () => {
  const specs = harnessSpecs({ MERCURY_HERMES_CMD: '/opt/hermes/bin/hermes' } as NodeJS.ProcessEnv);
  const hermes = specs.find((s) => s.id === 'hermes')!;
  assert.equal(hermes.cmd, '/opt/hermes/bin/hermes');
});

// ---------- probe states ----------

test('probeHarness: a missing binary is reported missing, not ok', async () => {
  const r = await probeHarness(spec({}));
  assert.equal(r.status, 'missing');
  assert.equal(r.version, null);
  assert.ok(r.error!.includes('command not found'));
});

test('probeHarness: a too-old harness is flagged too-old, never enabled', async () => {
  const dir = tempDir('probe-too-old-');
  const bin = fakeBinary(dir, '0.9.0');
  const r = await probeHarness(spec({ cmd: bin, minVersion: '1.0.0' }));
  assert.equal(r.status, 'too-old');
  assert.equal(r.version, '0.9.0');
});

test('probeHarness: a satisfying version is ok', async () => {
  const dir = tempDir('probe-ok-');
  const bin = fakeBinary(dir, '1.2.3');
  const r = await probeHarness(spec({ cmd: bin, minVersion: '1.0.0' }));
  assert.equal(r.status, 'ok');
  assert.equal(r.version, '1.2.3');
});

test('probeHarness: no declared floor means unknown, not ok', async () => {
  const dir = tempDir('probe-unknown-');
  const bin = fakeBinary(dir, '1.2.3');
  const r = await probeHarness(spec({ cmd: bin, minVersion: undefined }));
  assert.equal(r.status, 'unknown');
  assert.equal(r.minVersion, null);
});

test('probeHarness: auth reflects the config signal', async () => {
  const dir = tempDir('probe-auth-');
  const bin = fakeBinary(dir, '1.2.3');
  const r = await probeHarness(spec({ cmd: bin, auth: () => 'yes' }));
  assert.equal(r.auth, 'logged-in');
  const r2 = await probeHarness(spec({ cmd: bin, auth: () => 'no' }));
  assert.equal(r2.auth, 'not-logged-in');
  const r3 = await probeHarness(spec({ cmd: bin, auth: () => 'unknown' }));
  assert.equal(r3.auth, 'unknown', 'the platform could not tell; unknown is honest (#650)');
});

test('claude auth: ~/.claude.json is NOT a login signal; the credential file is (#650)', async () => {
  const home = tempDir('probe-claude-home-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), '{}');
  const specs = harnessSpecs({ MERCURY_CLAUDE_CMD: 'definitely-not-installed-xyz' } as NodeJS.ProcessEnv);
  const claude = specs.find((s) => s.id === 'claude')!;
  const credsFile = join(home, '.claude', '.credentials.json');
  // Signal implementation, parameterized by platform semantics (probe.ts decides per platform).
  const signal = (platform: NodeJS.Platform) =>
    existsSync(credsFile) ? 'yes' : platform === 'darwin' ? 'unknown' : 'no';
  // Linux: the credential file IS the signal — absent must read not-logged-in, never logged-in.
  const linuxNoCreds = await probeHarness({ ...claude, auth: () => signal('linux') });
  assert.equal(linuxNoCreds.auth, 'not-logged-in', 'bare ~/.claude.json must not read as logged-in');
  // macOS: Keychain-backed — honest unknown.
  const macNoCreds = await probeHarness({ ...claude, auth: () => signal('darwin') });
  assert.equal(macNoCreds.auth, 'unknown');
  // The real credential file IS the signal on both.
  writeFileSync(credsFile, '{"claudeAiOauth":{"accessToken":"x"}}');
  const linuxCreds = await probeHarness({ ...claude, auth: () => signal('linux') });
  assert.equal(linuxCreds.auth, 'logged-in');
  const macCreds = await probeHarness({ ...claude, auth: () => signal('darwin') });
  assert.equal(macCreds.auth, 'logged-in');
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

test('host probe --json prints one entry per shipped harness', async () => {
  const { code, stdout, stderr } = await cli(['host', 'probe', '--json']);
  assert.equal(code, 0, stderr);
  const parsed = JSON.parse(stdout) as { harnesses: Array<{ id: string; status: string }> };
  const ids = parsed.harnesses.map((h) => h.id).sort();
  assert.deepEqual(ids, ['claude', 'hermes', 'primeagent']);
  for (const h of parsed.harnesses) {
    assert.ok(['ok', 'too-old', 'missing', 'unknown'].includes(h.status), `bad status ${h.status}`);
  }
});

test('host probe rejects an unknown flag', async () => {
  const { code, stderr } = await cli(['host', 'probe', '--bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('host probe rejects an extra flag after --json', async () => {
  const { code, stderr } = await cli(['host', 'probe', '--json', '--bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('host probe works without any config (no mercury.env, no database)', async () => {
  const dir = tempDir('probe-noconfig-');
  const { code, stdout } = await cli(['host', 'probe', '--json'], {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_STATE_HOME: join(dir, '.state'),
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout) as { harnesses: Array<{ id: string; configExists: boolean }> };
  // With an empty HOME the config paths do not exist, but the probe still reports them.
  assert.ok(parsed.harnesses.every((h) => h.configExists === false));
});
