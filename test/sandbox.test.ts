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
