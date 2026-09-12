/**
 * Unknown config keys must be rejected, at every depth (issue #500).
 *
 * The defect was not "a typo disables goals" -- fail-closed is the right answer when a key is
 * genuinely absent. The defect was that a typo and a deliberate omission produced identical
 * results, so the operator had no way to tell which one they had. The nested case was worse than
 * the top-level one: `goalSupport: { sett: "1.0.0" }` is a truthy object, so the capability
 * getter advertises goal support backed by a version claim that does not exist -- failing later
 * and in the OPPOSITE direction from fail-closed.
 *
 * These tests therefore assert that the typo is REPORTED, not that valid configs still load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalAgentAdapter,
  validateLocalAgentConfig,
  type LocalAgentConfig,
} from '../src/adapters/localAgentAdapter.ts';
import {
  RpcAgentAdapter,
  validateRpcAgentConfig,
  type RpcAgentConfig,
} from '../src/adapters/rpcAgentAdapter.ts';
import {
  RemoteAgentAdapter,
  validateRemoteAgentConfig,
  type RemoteAgentConfig,
} from '../src/adapters/remoteAgentAdapter.ts';
import { findUnknownKeys, leaf, openMap, object } from '../src/adapters/configSchema.ts';
import { describeGoalCapabilities, logAdapterCapabilities } from '../src/adapters/capabilities.ts';
import { LocalAgentRegistry } from '../src/adapters/localAgentRegistry.ts';
import { readFileSync } from 'node:fs';
import type { AgentAdapter } from '../src/domain/types.ts';

function localCfg(overrides: Partial<LocalAgentConfig> = {}): LocalAgentConfig {
  return {
    id: 'claude-local',
    description: 'claude via local cli',
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
    id: 'pi',
    description: 'Pi Agent',
    command: process.execPath,
    args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' },
    eventMap: {},
    input: { enabled: true },
    resume: { enabled: true },
    ...overrides,
  } as RpcAgentConfig;
}

function remoteCfg(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: 'api-agent',
    description: 'remote api agent',
    api: {
      baseUrl: 'https://example.invalid',
      auth: { type: 'bearer', envVar: 'T', headerName: 'Authorization' },
      createTask: { method: 'POST', path: '/tasks', body: {}, idField: 'id' },
      getTask: { method: 'GET', path: '/tasks/{id}', statusField: 'state', statusMap: { done: 'completed' } },
    },
    poll: { intervalMs: 500, timeoutMs: 60_000 },
    eventMap: {},
    ...overrides,
  } as RemoteAgentConfig;
}

/** The three declarative validators, to assert parity comes from one implementation. */
const VALIDATORS: [string, (cfg: unknown) => void, () => unknown][] = [
  ['local', (c) => validateLocalAgentConfig(c as LocalAgentConfig), () => localCfg()],
  ['rpc', (c) => validateRpcAgentConfig(c as RpcAgentConfig), () => rpcCfg()],
  ['remote', (c) => validateRemoteAgentConfig(c as RemoteAgentConfig), () => remoteCfg()],
];

// --- criterion 1: top-level typo is reported, naming the key -----------------

test('a misspelled top-level key fails to load and names the key', () => {
  assert.throws(
    () => validateLocalAgentConfig(localCfg({ goalSuport: { set: '1.0.0' } } as never)),
    (err: Error) => /goalSuport/.test(err.message),
  );
});

test('the typo is reported rather than read as "no goals"', () => {
  // The original silent path: goalSuport yields no goalSupport, so the adapter quietly has none.
  const cfg = localCfg({ goalSuport: { set: '1.0.0' } } as never);
  assert.throws(() => validateLocalAgentConfig(cfg), /unknown config key/i);
  // And the adapter is never constructed from it, so nothing can advertise the wrong thing.
  assert.throws(() => new LocalAgentRegistry('/nonexistent').register(cfg));
});

// --- criterion 2: NESTED typo, the case that failed in the wrong direction ---

test('a misspelled NESTED key fails, naming the dotted path', () => {
  const err = (() => {
    try {
      validateLocalAgentConfig(localCfg({ goalSupport: { sett: '1.0.0' } } as never));
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err, 'goalSupport.sett was accepted -- a truthy object would advertise goal support');
  assert.match(err.message, /goalSupport\.sett/, `path not reported: ${err.message}`);
});

test('a nested typo in goalSupport never reaches the capability getter', () => {
  // Prove the consequence, not just the error. Before the fix, `{ sett: "1.0.0" }` was a truthy
  // object, so the getter returned goals={sett} and Mercury advertised support it could not
  // deliver. Now that config never produces an adapter at all.
  assert.throws(() => validateLocalAgentConfig(localCfg({ goalSupport: { sett: '1.0.0' } } as never)));
  assert.throws(() => new LocalAgentRegistry('/nonexistent').register(localCfg({ goalSupport: { sett: '1.0.0' } } as never)));

  // A well-formed claim still works, so the check is not simply rejecting goalSupport.
  const good = { set: '1.0.0', track: '1.2.0' };
  const ok = localCfg({ goalSupport: good });
  validateLocalAgentConfig(ok);
  assert.deepEqual(new LocalAgentAdapter(ok, {}).capabilities.goals, good);
});

test('nested typos are caught in every closed sub-object, not just goalSupport', () => {
  const cases: [string, () => void, RegExp][] = [
    ['cancel.graceMS', () => validateLocalAgentConfig(localCfg({ cancel: { signal: 'SIGTERM', graceMS: 5 } } as never)), /cancel\.graceMS/],
    ['resume.sessionIdPath typo', () => validateLocalAgentConfig(localCfg({ resume: { flag: '-r', sessionIdSource: 'event', sessionIdPat: 'x' } } as never)), /resume\.sessionIdPat/],
    ['taskInput.flg', () => validateLocalAgentConfig(localCfg({ taskInput: { mode: 'arg', flg: '--task' } } as never)), /taskInput\.flg/],
    ['api.auth.headerName typo', () => validateRemoteAgentConfig(remoteCfg({ api: { ...remoteCfg().api, auth: { type: 'bearer', envVar: 'T', headerNme: 'A' } } } as never)), /api\.auth\.headerNme/],
    ['poll.timeoutMs typo', () => validateRemoteAgentConfig(remoteCfg({ poll: { intervalMs: 1, timeoutMS: 2 } } as never)), /poll\.timeoutMS/],
    ['protocol.modeValue typo', () => validateRpcAgentConfig(rpcCfg({ protocol: { modeFlag: '--mode', modeValu: 'rpc' } } as never)), /protocol\.modeValu/],
  ];
  for (const [label, run, expected] of cases) {
    assert.throws(run, expected, `${label} was not reported`);
  }
});

// --- criterion 3: nearest key suggested, not the whole list ------------------

test('the error suggests the nearest recognised key', () => {
  assert.throws(
    () => validateLocalAgentConfig(localCfg({ goalSuport: { set: '1.0.0' } } as never)),
    /did you mean 'goalSupport'/,
  );
  assert.throws(
    () => validateLocalAgentConfig(localCfg({ goalSupport: { sett: '1.0.0' } } as never)),
    /did you mean 'set'/,
  );
});

test('the error does not dump every recognised key', () => {
  let message = '';
  try {
    validateLocalAgentConfig(localCfg({ taskInputt: { mode: 'arg', flag: '-t' } } as never));
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /taskInputt/);
  assert.match(message, /did you mean 'taskInput'/);
  // Listing all of them is the thing the issue rejected: the list only gets longer.
  for (const unrelated of ['description', 'sandbox', 'skills', 'resume']) {
    assert.ok(!message.includes(unrelated), `message listed unrelated key ${unrelated}`);
  }
});

test('a key too distant to be a typo gets no suggestion rather than a wrong one', () => {
  let message = '';
  try {
    validateLocalAgentConfig(localCfg({ zzzq: 'x' } as never));
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /zzzq/);
  assert.ok(!/did you mean/.test(message), `invented a suggestion: ${message}`);
});

test('every unknown key is reported in one pass, not one per restart', () => {
  assert.throws(
    () => validateLocalAgentConfig(localCfg({
      goalSuport: { set: '1.0.0' },
      sandboxx: { policyFlag: '-p' },
    } as never)),
    (err: Error) => /goalSuport/.test(err.message) && /sandboxx/.test(err.message),
  );
});

// --- criterion 4: one shared helper, three consumers ------------------------

test('all three declarative validators reject the same typo identically', () => {
  for (const [label, validate, base] of VALIDATORS) {
    const cfg = { ...(base() as object), goalSuport: { set: '1.0.0' } };
    assert.throws(
      () => validate(cfg),
      (err: Error) => /goalSuport/.test(err.message) && /did you mean 'goalSupport'/.test(err.message),
      `${label} did not report the typo the way its siblings do`,
    );
  }
});

test('the shared helper is what does the work, independent of any adapter', () => {
  const schema = object({ keep: leaf, nested: object({ inner: leaf }) });
  assert.deepEqual(findUnknownKeys({ keep: 1, nope: 2 }, schema), [{ path: '', key: 'nope', suggestion: undefined }]);
  assert.deepEqual(
    findUnknownKeys({ keep: 1, nested: { innerr: 1 } }, schema),
    [{ path: 'nested', key: 'innerr', suggestion: 'inner' }],
  );
});

// --- openness is declared, not assumed --------------------------------------

test('deliberately open maps still accept arbitrary keys', () => {
  // eventMap maps arbitrary AGENT event names; env carries arbitrary variable names. Rejecting
  // those would reject the feature, which is why openness is per node rather than global.
  validateLocalAgentConfig(localCfg({
    eventMap: { completed: 'done', 'tool_started': 'tool.started', 'weird-custom-frame': 'agent.message' },
    env: { ANTHROPIC_API_KEY: 'x', OTEL_EXPORTER_OTLP_ENDPOINT: 'y' },
  }));
  validateRemoteAgentConfig(remoteCfg({
    api: {
      ...remoteCfg().api,
      createTask: { method: 'POST', path: '/t', body: { anyField: { deeply: 'arbitrary' }, model: 'm' }, idField: 'id' },
      getTask: { method: 'GET', path: '/t', statusField: 's', statusMap: { whateverTheApiSays: 'completed' } },
    },
  }));
});

test('an open map still checks its values when the schema says to', () => {
  const schema = object({ tags: openMap(object({ name: leaf })) });
  assert.deepEqual(findUnknownKeys({ tags: { a: { name: 'x' } } }, schema), []);
  assert.deepEqual(findUnknownKeys({ tags: { a: { nme: 'x' } } }, schema),
    [{ path: 'tags.a', key: 'nme', suggestion: 'name' }]);
});

// --- valid configs still load ------------------------------------------------

test('valid configs for all three adapters still load', () => {
  for (const [label, validate, base] of VALIDATORS) {
    assert.doesNotThrow(() => validate(base()), `${label} rejected its own reference config`);
  }
  assert.doesNotThrow(() => validateLocalAgentConfig(localCfg({
    goalSupport: { set: '1.0.0', track: '1.2.0', tokenBudget: '1.2.0', contract: '2.0.0', gates: '2.1.0', maxTurns: '2.1.0' },
    args: ['-x'], cwd: '/tmp', sandbox: { policyFlag: '-p', policyValue: 'v' },
    skills: { flag: '--skill', values: { a: 'A' } }, env: { K: 'V' },
  })));
});

// --- criterion 5: the boot log line ----------------------------------------

test('adapter load renders the resolved capability set per agent', () => {
  const none = new LocalAgentAdapter(localCfg(), {});
  assert.equal(describeGoalCapabilities(none), 'none');
  const some = new LocalAgentAdapter(localCfg({ goalSupport: { set: '0.3.3', track: '0.3.3' } }), {});
  assert.equal(describeGoalCapabilities(some), 'set@0.3.3,track@0.3.3');
  // An empty claim renders as none rather than an empty string, so the log line never reads
  // `goals=` with nothing after it.
  const empty = { capabilities: { goals: {} }, detectVersion: async () => ({ version: 'version-unknown', raw: '' }) } as unknown as AgentAdapter;
  assert.equal(describeGoalCapabilities(empty), 'none');
});

test('adapter load emits one capability line per agent', () => {
  const lines: { fields: Record<string, unknown>; msg: string }[] = [];
  const log = { info: (fields: Record<string, unknown>, msg: string) => lines.push({ fields, msg }) };
  logAdapterCapabilities({
    'claude-local': new LocalAgentAdapter(localCfg(), {}),
    'claiming-agent': new LocalAgentAdapter(localCfg({ goalSupport: { set: '0.3.3' } }), {}),
  }, log);
  assert.equal(lines.length, 2, 'one line per registered agent');
  assert.deepEqual(lines.map((l) => l.fields.agent).sort(), ['claiming-agent', 'claude-local']);
  assert.deepEqual(lines.map((l) => l.fields.goals).sort(), ['none', 'set@0.3.3']);
  assert.ok(lines.every((l) => l.msg === 'adapter goal capabilities resolved'));
});

test('the capability log line is actually wired into the composition root', () => {
  // cli.ts starts a server on import, so this wiring cannot be exercised by calling it -- the
  // same reason selectAgentAdapter.ts exists. Without this assertion, deleting the call from
  // cli.ts leaves every other test in this file passing, which is precisely how a log line
  // that "should" be there stops being there.
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /logAdapterCapabilities\(adapters,\s*logger\)/,
    'cli.ts must emit the resolved capability set for every adapter at load');
  // ... and only where stdout is not reserved. gc prints a JSON report and the unknown-command
  // path must leave stdout empty, so an unguarded call breaks both.
  const call = cli.slice(cli.indexOf('logAdapterCapabilities(adapters'), 0);
  const guard = cli.slice(Math.max(0, cli.indexOf('logAdapterCapabilities(adapters') - 400),
    cli.indexOf('logAdapterCapabilities(adapters'));
  for (const serving of ["'server'", "'dev'", "'worker'"]) {
    assert.ok(guard.includes(serving), `capability log is not guarded to serving commands: missing ${serving}`);
  }
  void call;
});
