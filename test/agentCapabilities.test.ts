/**
 * Capability registry and the adapter declarations behind it (docs/goals.md 13).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentCapabilityRegistry } from '../src/adapters/capabilities.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCodeAdapter.ts';
import { DaemonAgentAdapter } from '../src/adapters/daemonAgentAdapter.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import { HermesAgentAdapter } from '../src/adapters/hermesAgentAdapter.ts';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import type { AgentAdapter, AgentVersionInfo } from '../src/domain/types.ts';

function stub(overrides: Partial<AgentAdapter> & { capabilities: AgentAdapter['capabilities'] }): AgentAdapter {
  return {
    start: async () => { throw new Error('not used'); },
    sendInput: async () => {},
    cancel: async () => {},
    ...overrides,
  } as AgentAdapter;
}

test('an adapter with no binary stays version-unknown rather than guessing', async () => {
  // Remote agents have nothing to ask. Unknown must not become "supported" (assume-yes)
  // and must not become "unsupported" (which would tell the operator to switch agent).
  const reg = new AgentCapabilityRegistry({
    cloud: stub({ capabilities: { goals: { set: '1.0.0' } } }),
  });
  reg.start();
  await reg.settle();
  const cap = reg.goalCapability('cloud');
  assert.equal(cap?.supported, false);
  assert.equal(cap?.reason, 'version-unknown');
});

test('a declared backend becomes supported once the probe reports a sufficient version', async () => {
  const reg = new AgentCapabilityRegistry({
    pa: stub({
      capabilities: { goals: { set: '0.3.3' } },
      detectVersion: async (): Promise<AgentVersionInfo> => ({ version: '0.9.4', raw: '0.9.4' }),
    }),
  });
  reg.start();
  await reg.settle();
  assert.equal(reg.goalCapability('pa')?.supported, true);
  assert.equal(reg.snapshot().pa?.version, '0.9.4');
});

test('a probe that throws is isolated and recorded, not propagated', async () => {
  // One adapter misbehaving must not strand the others or surface an unhandled rejection
  // from a detached startup probe.
  const reg = new AgentCapabilityRegistry({
    bad: stub({ capabilities: { goals: { set: '1.0.0' } }, detectVersion: async () => { throw new Error('boom'); } }),
    good: stub({ capabilities: { goals: { set: '1.0.0' } }, detectVersion: async () => ({ version: '2.0.0', raw: '2.0.0' }) }),
  });
  reg.start();
  await reg.settle();
  assert.equal(reg.goalCapability('bad')?.supported, false);
  assert.equal(reg.goalCapability('bad')?.reason, 'version-unknown');
  assert.equal(reg.goalCapability('good')?.supported, true, 'a sibling probe failure must not block this one');
});

test('start() is idempotent', async () => {
  let calls = 0;
  const reg = new AgentCapabilityRegistry({
    x: stub({ capabilities: { goals: { set: '1.0.0' } }, detectVersion: async () => { calls += 1; return { version: '1.0.0', raw: 'x' }; } }),
  });
  reg.start();
  reg.start();
  await reg.settle();
  assert.equal(calls, 1, 'probing twice per agent doubles startup subprocesses');
});

test('an unknown agent id resolves to no capability rather than throwing', () => {
  const reg = new AgentCapabilityRegistry({ fake: stub({ capabilities: {} }) });
  assert.equal(reg.goalCapability('nope'), null);
});

// --- the declarations themselves ---------------------------------------------

test('every shipped adapter DECLARES capabilities rather than omitting them', () => {
  // The interface makes `capabilities` required, so this is already a compile error if a
  // new adapter forgets. This test keeps that true for adapters constructed dynamically
  // and documents the intent: absent means "never", which is a claim, not a shrug.
  const shipped: Record<string, AgentAdapter> = {
    primeagent: new PrimeAgentAdapter('prime-agent'),
    daemon: new DaemonAgentAdapter('prime-agent', {}),
    hermes: new HermesAgentAdapter({}),
    claude: new ClaudeCodeAdapter({}),
    fake: new FakeAgentAdapter({ script: [] }),
  };
  for (const [id, adapter] of Object.entries(shipped)) {
    assert.ok('capabilities' in adapter, `${id} must declare capabilities`);
    assert.equal(typeof adapter.capabilities, 'object', `${id} capabilities must be an object`);
  }
});

test('only the RPC PrimeAgent adapter claims goal support, at the version the flags shipped in', () => {
  const pa = new PrimeAgentAdapter('prime-agent').capabilities.goals;
  assert.equal(pa?.set, '0.3.3', '--goal / --goal-token-budget landed in 0.3.3 (upstream PR #514)');
  assert.equal(pa?.track, '0.3.3');
  assert.equal(pa?.tokenBudget, '0.3.3');
  // PrimeAgent has no contract/gates concept; accepting those fields and dropping them
  // silently is the failure mode this whole feature is designed to avoid.
  assert.equal(pa?.contract, undefined);
  assert.equal(pa?.gates, undefined);
});

test('the same agent id reports different capability under a different adapter', () => {
  // `primeagent` resolves to PrimeAgentAdapter or DaemonAgentAdapter on MERCURY_AGENT_MODE.
  // Only the RPC one has a goal channel, so capability cannot be keyed on the agent name --
  // which is why the registry is built from adapter instances, not from the id list.
  const rpc = new PrimeAgentAdapter('prime-agent').capabilities.goals?.set;
  const daemon = new DaemonAgentAdapter('prime-agent', {}).capabilities.goals?.set;
  assert.equal(rpc, '0.3.3');
  assert.equal(daemon, undefined, 'daemon protocol carries no goal channel');
});

test('Hermes declares no goal support despite having the richest goal model', () => {
  // The matrix is keyed on what Mercury can reach, not on what the harness can do.
  // Hermes has GoalContract, gates and a judge; none are reachable from `hermes chat -Q`.
  assert.equal(new HermesAgentAdapter({}).capabilities.goals?.set, undefined);
  assert.equal(new ClaudeCodeAdapter({}).capabilities.goals?.set, undefined);
  assert.equal(new FakeAgentAdapter({ script: [] }).capabilities.goals?.set, undefined);
});
