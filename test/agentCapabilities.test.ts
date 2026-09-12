/**
 * Capability registry and the adapter declarations behind it (docs/goals.md 13).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentAdapter, type LocalAgentConfig } from '../src/adapters/localAgentAdapter.ts';
import { RpcAgentAdapter, type RpcAgentConfig } from '../src/adapters/rpcAgentAdapter.ts';
import { RemoteAgentAdapter, type RemoteAgentConfig } from '../src/adapters/remoteAgentAdapter.ts';

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
  // new adapter forgets. NOTE (issue #496): the comment here used to claim this test "keeps
  // that true for adapters constructed dynamically" while listing five adapters and omitting
  // the three config-driven ones -- the only ones with no compile-time protection at all.
  // The real coverage lives in `ALL EIGHT shipped adapters...` below; this one is kept
  // because it documents the intent: absent means "never", which is a claim, not a shrug.
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


// --- the guard itself, and proof that it reports (issue #496) -----------------

/**
 * The check the coverage guard applies, extracted so it can be aimed at something that
 * SHOULD fail. A guard whose only evidence is "no violations today" proves nothing: it
 * passes just as happily when it has stopped looking at anything.
 *
 * `capabilities` is required on the interface, so omitting it is a compile error for a
 * statically written adapter. What the interface cannot catch is the shape of the value,
 * and it says nothing at all about the three config-driven adapters, whose declaration is
 * built at runtime from a JSON file.
 */
function declarationViolations(id: string, adapter: AgentAdapter): string[] {
  const v: string[] = [];
  const caps = (adapter as { capabilities?: unknown }).capabilities;
  if (caps === undefined) return [`${id}: declares no capabilities at all`];
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    return [`${id}: capabilities must be a plain object, got ${typeof caps}`];
  }
  const goals = (caps as { goals?: unknown }).goals;
  if (goals !== undefined) {
    if (typeof goals !== 'object' || goals === null) v.push(`${id}: goals must be an object`);
    else if (Object.keys(goals).length === 0) v.push(`${id}: goals is present but empty -- declare no goals key instead`);
    else {
      for (const [field, min] of Object.entries(goals as Record<string, unknown>)) {
        if (typeof min !== 'string' || !/^\d+\.\d+\.\d+/.test(min)) {
          v.push(`${id}: goals.${field} must be a minimum version string, got ${JSON.stringify(min)}`);
        }
      }
    }
  }
  return v;
}

function localCfg(overrides: Partial<LocalAgentConfig> = {}): LocalAgentConfig {
  return {
    id: 'cfg-agent',
    description: 'declarative local agent',
    command: process.execPath,
    args: [],
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: { completed: 'done' },
    cancel: { signal: 'SIGTERM', graceMs: 100 },
    ...overrides,
  } as LocalAgentConfig;
}

function rpcCfg(overrides: Partial<RpcAgentConfig> = {}): RpcAgentConfig {
  return {
    id: 'cfg-rpc',
    description: 'declarative rpc agent',
    command: process.execPath,
    args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' },
    eventMap: {},
    input: { enabled: false },
    resume: { enabled: false },
    ...overrides,
  } as RpcAgentConfig;
}

function remoteCfg(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: 'cfg-remote',
    description: 'declarative remote agent',
    api: {
      baseUrl: 'https://example.invalid',
      auth: { type: 'bearer', envVar: 'CFG_TOKEN', headerName: 'Authorization' },
      createTask: { method: 'POST', path: '/tasks', body: {}, idField: 'id' },
      getTask: { method: 'GET', path: '/tasks/{id}', statusField: 'state', statusMap: { done: 'completed' } },
    },
    poll: { intervalMs: 500, timeoutMs: 60_000 },
    eventMap: {},
    ...overrides,
  } as RemoteAgentConfig;
}

/** Every adapter that implements AgentAdapter in src/adapters, not a subset of them. */
function allShippedAdapters(): Record<string, AgentAdapter> {
  return {
    primeagent: new PrimeAgentAdapter('prime-agent'),
    daemon: new DaemonAgentAdapter('prime-agent', {}),
    hermes: new HermesAgentAdapter({}),
    claude: new ClaudeCodeAdapter({}),
    fake: new FakeAgentAdapter({ script: [] }),
    local: new LocalAgentAdapter(localCfg(), {}),
    rpc: new RpcAgentAdapter(rpcCfg(), {}),
    remote: new RemoteAgentAdapter(remoteCfg(), {}),
  };
}

test('ALL EIGHT shipped adapters declare capabilities in a usable shape', () => {
  const shipped = allShippedAdapters();
  // The old guard listed five and its comment claimed it covered "adapters constructed
  // dynamically" while omitting exactly the three config-driven ones.
  assert.equal(Object.keys(shipped).length, 8, 'the guard must cover every AgentAdapter implementation');
  const violations = Object.entries(shipped).flatMap(([id, a]) => declarationViolations(id, a));
  assert.deepEqual(violations, []);
});

test('the guard REPORTS a bad declaration instead of passing quietly', () => {
  // Without this, the test above is indistinguishable from a guard that stopped looking.
  const broken: [string, AgentAdapter][] = [
    ['omits-capabilities', { detectVersion: async () => ({ version: 'version-unknown', raw: '' }) } as unknown as AgentAdapter],
    ['capabilities-not-an-object', { capabilities: 'yes', detectVersion: async () => ({ version: 'version-unknown', raw: '' }) } as unknown as AgentAdapter],
    ['empty-goals-object', { capabilities: { goals: {} }, detectVersion: async () => ({ version: 'version-unknown', raw: '' }) } as unknown as AgentAdapter],
    ['unparsable-minimum-version', { capabilities: { goals: { set: 'yes please' } }, detectVersion: async () => ({ version: 'version-unknown', raw: '' }) } as unknown as AgentAdapter],
  ];
  for (const [id, adapter] of broken) {
    const v = declarationViolations(id, adapter);
    assert.ok(v.length > 0, `the guard stayed silent about ${id}`);
  }
});

test('a declarative adapter with no goalSupport declares NO goals, and fails closed', () => {
  // Absent config key means "never", which is a claim rather than a shrug. This is the
  // behaviour the three config-driven adapters share, and nothing asserted it before.
  for (const [label, adapter] of [
    ['local', new LocalAgentAdapter(localCfg(), {})],
    ['rpc', new RpcAgentAdapter(rpcCfg(), {})],
    ['remote', new RemoteAgentAdapter(remoteCfg(), {})],
  ] as [string, AgentAdapter][]) {
    assert.deepEqual(adapter.capabilities, {}, `${label}: a config with no goalSupport must declare nothing`);
    assert.deepEqual(declarationViolations(label, adapter), []);
  }
});

test('a declarative adapter WITH goalSupport declares exactly what the config claims', () => {
  const support = { set: '1.0.0', track: '1.2.0' };
  const local = new LocalAgentAdapter(localCfg({ goalSupport: support }), {});
  assert.deepEqual(local.capabilities.goals, support);
  const rpc = new RpcAgentAdapter(rpcCfg({ goalSupport: support }), {});
  assert.deepEqual(rpc.capabilities.goals, support);
  // A claim is only a claim until the detected version is checked; declaring here is not
  // the same as being admitted, which is what 13.5 is about.
  assert.deepEqual(declarationViolations('local', local), []);
});
