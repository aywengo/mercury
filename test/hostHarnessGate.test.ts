/**
 * MERCURY_HARNESSES is read by the host (issue #645): the wizard writes it, and
 * src/cli.ts must register adapters only for the shipped harnesses in the allowlist.
 * `fake` and the declarative local/remote/rpc agents are not host harnesses and are
 * never filtered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { applyHarnessGate, loadConfig, parseHarnesses, HOST_HARNESSES } from '../src/config.ts';

const ROOT = resolve(import.meta.dirname, '..');

test('parseHarnesses: unset or blank means every shipped harness', () => {
  assert.equal(parseHarnesses(undefined), null);
  assert.equal(parseHarnesses(''), null);
  assert.equal(parseHarnesses('  '), null);
});

test('parseHarnesses: parses a comma list, trims, drops empties', () => {
  assert.deepEqual(parseHarnesses('primeagent, claude'), ['primeagent', 'claude']);
  assert.deepEqual(parseHarnesses('hermes'), ['hermes']);
});

test('parseHarnesses: unknown id fails loud (silent typo = harness silently off)', () => {
  assert.throws(() => parseHarnesses('primeagent,primagent'), /unknown harness 'primagent'/);
  assert.throws(() => parseHarnesses('fake'), /unknown harness 'fake'/);
});

test('parseHarnesses: only whitespace entries means unset', () => {
  assert.equal(parseHarnesses(' , , '), null);
});

test('loadConfig throws a readable error on an unknown MERCURY_HARNESSES id', () => {
  // A silent typo would disable nothing visibly; load-time loudness puts the fix in the
  // boot log (the host subcommands run before loadConfig, so the operator can still fix it).
  assert.throws(() => loadConfig({ MERCURY_HARNESSES: 'primagent' } as NodeJS.ProcessEnv),
    /MERCURY_HARNESSES: unknown harness 'primagent'/);
  const cfg = loadConfig({ MERCURY_HARNESSES: 'primeagent,claude' } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.harnesses, ['primeagent', 'claude']);
});

const adapters = { primeagent: 'PA', hermes: 'HE', claude: 'CL', fake: 'FA', myagent: 'LO' };

test('applyHarnessGate: null list passes everything through', () => {
  assert.deepEqual(applyHarnessGate(adapters, null), adapters);
});

test('applyHarnessGate: a disabled shipped harness loses its adapter', () => {
  const gated = applyHarnessGate(adapters, ['primeagent']);
  assert.deepEqual(Object.keys(gated).sort(), ['fake', 'myagent', 'primeagent']);
  assert.ok(!('hermes' in gated) && !('claude' in gated));
});

test('applyHarnessGate: fake and declarative agents are never filtered', () => {
  const gated = applyHarnessGate(adapters, []);
  assert.deepEqual(Object.keys(gated).sort(), ['fake', 'myagent']);
});

test('applyHarnessGate: does not mutate the input map', () => {
  const before = { ...adapters };
  applyHarnessGate(adapters, ['hermes']);
  assert.deepEqual(adapters, before);
});

test('HOST_HARNESSES matches the shipped CLI adapters', () => {
  // The three shipped host harnesses (docs/host-installer.md): PrimeAgent, Hermes,
  // Claude Code. A fourth shipped adapter is a scope change and must update this list.
  assert.deepEqual([...HOST_HARNESSES].sort(), ['claude', 'hermes', 'primeagent']);
});

test('wiring: src/cli.ts applies the gate before any consumer reads the adapters map', () => {
  // The registry is a plain object literal, so a dropped call would leave every unit
  // test green while MERCURY_HARNESSES did nothing (the wiring-is-not-typed failure
  // class). configUnknownKeys.test.ts sets the precedent for source assertions here.
  const src = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
  const gateAt = src.indexOf('const gatedAdapters = applyHarnessGate(adapters, config.harnesses)');
  assert.ok(gateAt > 0, 'src/cli.ts must apply the harness gate to the adapters map');
  const uses = ['logAdapterCapabilities(', 'new AgentCapabilityRegistry(', 'knownAgents: Object.keys(', 'adapters: gatedAdapters'];
  for (const use of uses) {
    const i = src.indexOf(use, gateAt);
    assert.ok(i > gateAt, use + ' must come after the gate');
  }
  // The raw map must not reach any consumer after the gate is applied.
  const tail = src.slice(gateAt).split('gatedAdapters').join('');
  assert.ok(!tail.includes(' adapters,'), 'the worker must receive gatedAdapters, not adapters');
  assert.ok(!tail.includes('logAdapterCapabilities(adapters)'), 'capability log must read the gated map');
});
