// Sandboxed execution tests (Mercury.md roadmap #2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SandboxManager, detectRuntime } from '../src/sandbox/sandboxManager.ts';
import type { Run } from '../src/domain/types.ts';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1234567890ab',
    ownerId: 'owner',
    task: 'test task',
    repository: { url: 'https://example.com/repo.git', baseBranch: 'main' },
    workspaceBranch: null,
    workspacePath: '/tmp/ws',
    agent: 'primeagent',
    status: 'QUEUED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 0 },
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
    ...overrides,
  };
}

test('requiresSandbox: true only when constraints request isolation', () => {
  const sb = new SandboxManager({ runtime: 'docker' });
  assert.equal(sb.requiresSandbox(makeRun()), false);
  assert.equal(sb.requiresSandbox(makeRun({ constraints: { maxDurationMs: 1000, maxRetries: 0, resourceLimits: { cpu: '1' } } })), true);
  assert.equal(sb.requiresSandbox(makeRun({ constraints: { maxDurationMs: 1000, maxRetries: 0, allowedNetworks: [] } })), true);
  assert.equal(sb.requiresSandbox(makeRun({ constraints: { maxDurationMs: 1000, maxRetries: 0, allowedNetworks: ['api.example.com'] } })), true);
});

test('buildCommand: docker args with limits and network policy', () => {
  const sb = new SandboxManager({ runtime: 'docker', image: 'node:22' });
  const run = makeRun({
    workspacePath: '/srv/ws',
    constraints: {
      maxDurationMs: 1000, maxRetries: 0,
      resourceLimits: { cpu: '0.5', memory: '256m' },
      allowedNetworks: [],
    },
  });
  const cmd = sb.buildCommand(run, 'prime-agent', ['--mode', 'rpc', '--cwd', '/srv/ws']);
  assert.equal(cmd.cmd, 'docker');
  assert.deepEqual(cmd.args, [
    'run', '--rm', '-i', '--name', 'mercury-run-12345678',
    '-v', '/srv/ws:/srv/ws',
    '--cpus', '0.5',
    '--memory', '256m',
    '--network', 'none',
    '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'node:22', 'prime-agent', '--mode', 'rpc', '--cwd', '/srv/ws',
  ]);
});

test('buildCommand: bridge network when networks are allowed', () => {
  const sb = new SandboxManager({ runtime: 'podman' });
  const run = makeRun({
    workspacePath: '/srv/ws',
    constraints: { maxDurationMs: 1000, maxRetries: 0, allowedNetworks: ['api.example.com'] },
  });
  const cmd = sb.buildCommand(run, 'prime-agent', ['--mode', 'rpc']);
  assert.equal(cmd.cmd, 'podman');
  assert.ok(cmd.args.includes('--network'));
  assert.ok(cmd.args.includes('bridge'));
  assert.ok(!cmd.args.includes('none'));
});

test('available: false when runtime is none or binary missing', async () => {
  const sbNone = new SandboxManager({ runtime: 'none' });
  assert.equal(await sbNone.available(), false);
  const sbMissing = new SandboxManager({ runtime: 'definitely-not-a-real-runtime-xyz' });
  assert.equal(await sbMissing.available(), false);
});

test('detectRuntime: returns null when no container runtime installed', async () => {
  // In the test environment neither docker nor podman is guaranteed; the function
  // must not throw and returns null when both are absent.
  const rt = await detectRuntime();
  assert.ok(rt === null || rt.name === 'docker' || rt.name === 'podman');
});



test('PrimeAgentAdapter wraps spawn in container when run requests isolation', async () => {
  const { PrimeAgentAdapter } = await import('../src/adapters/primeAgentAdapter.ts');
  const sb = new SandboxManager({ runtime: 'docker', image: 'node:22' });
  const adapter = new PrimeAgentAdapter('/usr/bin/prime-agent', { sandbox: sb });
  const run = makeRun({
    workspacePath: '/srv/ws',
    constraints: {
      maxDurationMs: 1000, maxRetries: 0,
      resourceLimits: { cpu: '1', memory: '512m' },
      allowedNetworks: [],
    },
  });
  const ctx = {
    run,
    repository: run.repository,
    workspace: { path: '/srv/ws', branch: 'agent/x', baseCommit: 'abc', mode: 'copy' as const },
    skills: [],
    constraints: run.constraints,
  };
  const wrapped = (adapter as unknown as { wrapForSandbox(r: typeof ctx, a: string[]): { cmd: string; args: string[] } })
    .wrapForSandbox(ctx, ['--mode', 'rpc', '--cwd', '/srv/ws']);
  assert.equal(wrapped.cmd, 'docker');
  assert.ok(wrapped.args.includes('--cpus'));
  assert.ok(wrapped.args.includes('1'));
  assert.ok(wrapped.args.includes('--memory'));
  assert.ok(wrapped.args.includes('512m'));
  assert.ok(wrapped.args.includes('--network'));
  assert.ok(wrapped.args.includes('none'));
  assert.ok(wrapped.args.includes('node:22'));
  assert.ok(wrapped.args.includes('/usr/bin/prime-agent'));
});

test('PrimeAgentAdapter does not wrap when no isolation requested', async () => {
  const { PrimeAgentAdapter } = await import('../src/adapters/primeAgentAdapter.ts');
  const sb = new SandboxManager({ runtime: 'docker' });
  const adapter = new PrimeAgentAdapter('/usr/bin/prime-agent', { sandbox: sb });
  const run = makeRun({ workspacePath: '/srv/ws' });
  const ctx = {
    run,
    repository: run.repository,
    workspace: { path: '/srv/ws', branch: 'agent/x', baseCommit: 'abc', mode: 'copy' as const },
    skills: [],
    constraints: run.constraints,
  };
  const wrapped = (adapter as unknown as { wrapForSandbox(r: typeof ctx, a: string[]): { cmd: string; args: string[] } })
    .wrapForSandbox(ctx, ['--mode', 'rpc']);
  assert.equal(wrapped.cmd, '/usr/bin/prime-agent');
  assert.deepEqual(wrapped.args, ['--mode', 'rpc']);
});

test('worker fail-closed: run requesting isolation without runtime fails', async () => {
  const { makeEnv } = await import('./helpers.ts');
  const repoDir = mkdtempSync(join(tmpdir(), 'mercury-sandbox-repo-'));
  execFileSync('git', ['init', '-q', repoDir]);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 't']);
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  execFileSync('git', ['-C', repoDir, 'add', '.']);
  execFileSync('git', ['-C', repoDir, 'commit', '-qm', 'init']);
  const sb = new SandboxManager({ runtime: 'definitely-not-a-real-runtime-xyz' });
  const env = makeEnv({ workerEnabled: true, sandbox: sb, workspaceMode: 'copy', repoDir });
  try {
    const run = await env.runService.create({
      ownerId: 'owner',
      task: 'sandboxed task',
      repository: { localPath: repoDir },
      agent: 'fake',
      constraints: { maxDurationMs: 60_000, maxRetries: 0, resourceLimits: { cpu: '1' } },
    });
    // Wait for the worker to pick it up and fail it.
    await new Promise((r) => setTimeout(r, 500));
    const row = env.runs.get(run.id);
    assert.ok(row);
    assert.equal(row.status, 'FAILED');
    assert.match(row.error ?? '', /sandboxed execution.*no container runtime/i);
  } finally {
    env.close();
  }
});

// --- environment passthrough and disk-limit portability (issue #56) ---------

const LIMITS = { maxDurationMs: 1000, maxRetries: 0, resourceLimits: { cpu: '1' } };

function envFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--env') out.push(args[i + 1] ?? '');
  return out;
}

test('buildCommand: forwards allowlisted provider credentials, not just PATH (issue #56)', () => {
  // The comment promised API-key inheritance while the code forwarded only PATH, so every
  // sandboxed run died at its first model call with what looked like a provider error.
  const saved = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.SOME_UNRELATED_SECRET = 'should-not-appear';
    delete process.env.GEMINI_API_KEY; // an allowlisted name that is unset contributes nothing

    const sb = new SandboxManager({ runtime: 'docker' });
    const flags = envFlags(sb.buildCommand(makeRun({ constraints: LIMITS }), 'prime-agent', ['--mode', 'rpc']).args);

    assert.ok(flags.includes('ANTHROPIC_API_KEY=sk-ant-test'), `provider key not forwarded: ${JSON.stringify(flags)}`);
    assert.ok(flags.includes('OPENAI_API_KEY=sk-test'), 'second provider key not forwarded');
    assert.ok(!flags.some((f) => f.startsWith('GEMINI_API_KEY=')), 'an unset allowlisted var must not be forwarded as empty');
    assert.ok(!flags.some((f) => f.includes('should-not-appear')), 'a var outside the allowlist must never be forwarded');
    assert.ok(flags.some((f) => f.startsWith('PATH=')), 'PATH is still pinned');
  } finally {
    process.env = saved;
  }
});

test('buildCommand: never forwards Mercury secrets even when explicitly allowlisted (issue #56)', () => {
  // The container runs UNTRUSTED agents. MERCURY_* holds the admin token, the API tokens and
  // the database path, so these are blocked at the forward step rather than relying on nobody
  // ever putting them in MERCURY_SANDBOX_ENV.
  const saved = { ...process.env };
  try {
    process.env.MERCURY_ADMIN_TOKEN = 'admin-secret';
    process.env.MERCURY_DB_PATH = '/var/lib/mercury/mercury.db';
    process.env.GH_TOKEN = 'ghp_secret';

    const sb = new SandboxManager({
      runtime: 'docker',
      // Deliberately hostile configuration: an operator who shoots themselves in the foot with
      // an over-broad allowlist must still not hand over the service.
      envAllowlist: ['MERCURY_ADMIN_TOKEN', 'MERCURY_DB_PATH', 'GH_TOKEN', 'ANTHROPIC_API_KEY'],
    });
    const flags = envFlags(sb.buildCommand(makeRun({ constraints: LIMITS }), 'prime-agent', []).args);

    assert.ok(!flags.some((f) => f.startsWith('MERCURY_')), `MERCURY_* leaked into the sandbox: ${JSON.stringify(flags)}`);
    assert.ok(!flags.some((f) => f.startsWith('GH_TOKEN=')), 'source-control credentials must not be forwarded');
    assert.ok(!flags.some((f) => f.includes('admin-secret') || f.includes('ghp_secret')), 'a secret value leaked');
  } finally {
    process.env = saved;
  }
});

test('buildCommand: an explicitly empty allowlist forwards nothing but PATH (issue #56)', () => {
  const saved = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const sb = new SandboxManager({ runtime: 'docker', envAllowlist: [] });
    const flags = envFlags(sb.buildCommand(makeRun({ constraints: LIMITS }), 'prime-agent', []).args);
    assert.deepEqual(flags.filter((f) => !f.startsWith('PATH=')), [],
      'an operator narrowing the allowlist to nothing must get exactly that');
  } finally {
    process.env = saved;
  }
});

test('buildCommand: a requested disk limit fails loudly instead of emitting an unsupported flag (issue #56)', () => {
  // `--storage-opt size=` is honoured only by overlay2-on-xfs, btrfs, zfs or devicemapper. On
  // the default overlay2-on-ext4 docker install the flag makes `docker run` fail before the
  // agent starts, with an error naming neither disk nor Mercury.
  const sb = new SandboxManager({ runtime: 'docker' });
  const run = makeRun({
    constraints: { maxDurationMs: 1000, maxRetries: 0, resourceLimits: { cpu: '1', disk: '5G' } },
  });
  assert.throws(() => sb.buildCommand(run, 'prime-agent', []), (err: unknown) => {
    const msg = String(err instanceof Error ? err.message : err);
    assert.ok(/disk/i.test(msg), `error must name the disk limit, got: ${msg}`);
    assert.ok(/MERCURY_SANDBOX_DISK_LIMITS/.test(msg), 'error must name the switch that enables it');
    assert.ok(/overlay2|ext4|xfs/i.test(msg), 'error must explain which drivers support it');
    return true;
  });
});

test('buildCommand: disk limit is passed once the host declares support (issue #56)', () => {
  const sb = new SandboxManager({ runtime: 'docker', diskLimitsSupported: true });
  const run = makeRun({
    constraints: { maxDurationMs: 1000, maxRetries: 0, resourceLimits: { cpu: '1', disk: '5G' } },
  });
  const args = sb.buildCommand(run, 'prime-agent', []).args;
  const i = args.indexOf('--storage-opt');
  assert.ok(i >= 0, 'the flag must be passed when the host supports it');
  assert.equal(args[i + 1], 'size=5G');
});
