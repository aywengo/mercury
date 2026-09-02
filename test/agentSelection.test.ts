// Which adapter the `primeagent` agent name resolves to, and the config that drives it.
//
// The selection used to be an inline ternary in cli.ts, which cannot be imported by a test because it
// starts a server on import. Nothing covered it, so a swapped branch would have shipped with the whole
// suite green and daemon mode unreachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPrimeAgentAdapter } from '../src/adapters/selectAgentAdapter.ts';
import { DaemonAgentAdapter } from '../src/adapters/daemonAgentAdapter.ts';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import { loadConfig } from '../src/config.ts';

const opts = { args: ['--model', 'm'], workerId: 'w1' };

test('daemon mode selects the daemon adapter', () => {
  const a = selectPrimeAgentAdapter('daemon', 'prime-agent', opts);
  assert.ok(a instanceof DaemonAgentAdapter, a.constructor.name);
});

test('rpc mode selects the rpc adapter', () => {
  const a = selectPrimeAgentAdapter('rpc', 'prime-agent', opts);
  assert.ok(a instanceof PrimeAgentAdapter, a.constructor.name);
});

test('anything that is not exactly daemon is rpc', () => {
  // A value that half-matches must not reach a transport that needs a running supervisor.
  for (const mode of ['DAEMON', ' daemon', 'daemon ', '', 'daemons'] as const) {
    const a = selectPrimeAgentAdapter(mode as 'rpc' | 'daemon', 'prime-agent', opts);
    assert.ok(a instanceof PrimeAgentAdapter, `${JSON.stringify(mode)} -> ${a.constructor.name}`);
  }
});

test('RPC stays the default; daemon is strictly opt-in', () => {
  assert.equal(loadConfig({}).agentMode, 'rpc', 'a fresh install must not require a supervisor');
  assert.equal(loadConfig({ MERCURY_AGENT_MODE: 'true' }).agentMode, 'rpc',
    'a truthy-looking value must not enable daemon mode');
  assert.equal(loadConfig({ MERCURY_AGENT_MODE: 'daemon' }).agentMode, 'daemon');
});
