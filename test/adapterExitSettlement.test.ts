import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settleExit, rearmExitGate, createExitGate } from '../src/adapters/exitSettlement.ts';
import type { AgentExit } from '../src/domain/types.ts';

// Issue #148 (R2-12). Round 1 promised a shared adapter base as remediation step 9 and marked it
// delivered; it was never built, and six adapters each grew their own copy of exit settlement -- five
// of them byte-identical. These tests cover the shared module's behaviour AND the structural claim
// that the adapters no longer own it.

const ADAPTER_DIR = new URL('../src/adapters/', import.meta.url).pathname;

/** Adapter source files, excluding the shared module itself. */
function adapterSources(): Array<{ name: string; code: string }> {
  return readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'exitSettlement.ts')
    .map((f) => ({ name: f, code: readFileSync(join(ADAPTER_DIR, f), 'utf8') }));
}

/**
 * Strip comments so the guard reads live code only.
 *
 * The first version of this scanner tripped on prose: the shared module and the adapters both explain
 * the bug in comments, and those comments quote the very code the guard forbids. Quote-aware so a `//`
 * inside a string literal is not mistaken for a comment start.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (str) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i += 1; continue; }
    if (two === '//') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (two === '/*') { i = src.indexOf('*/', i); i = i < 0 ? src.length : i + 2; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** The patterns that mean an adapter has re-implemented exit settlement. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['declares its own settleExit()', /function\s+settleExit\b/],
  ['writes exitSettled directly', /\bexitSettled\s*=[^=]/],
  ['calls exitResolve directly', /\bexitResolve\s*\(/],
];

function violations(code: string): string[] {
  const live = stripComments(code);
  return FORBIDDEN.filter(([, re]) => re.test(live)).map(([label]) => label);
}

test('settleExit settles exactly once and keeps the FIRST reason', async () => {
  // The guard is the whole point of the module. A transport reports completion through several racing
  // paths -- child exit, stream end, socket close, cancel, timeout. Resolving an already-resolved
  // promise is a LANGUAGE NO-OP, so a second settle does not overwrite anything today: the first
  // reason wins because the promise already settled, not because the guard did anything. The guard is
  // still the contract, and it is what keeps it that way -- the moment exitResolve does anything beyond
  // resolving (logging, emitting, clearing a timer), a second call stops being harmless and
  // first-writer-wins becomes a property the module has to enforce rather than inherit.
  // The next test asserts that contract directly, with a counting resolver.
  const gate = createExitGate();
  const session = { ...gate };

  settleExit(session, { code: 0, signal: null, reason: 'cancelled' });
  settleExit(session, { code: 1, signal: null, reason: 'failed' });
  settleExit(session, { code: 0, signal: null, reason: 'completed' });

  assert.equal(session.exitSettled, true);
  assert.deepEqual(await session.exitPromise, { code: 0, signal: null, reason: 'cancelled' });
});

test('settleExit invokes the resolver AT MOST ONCE', () => {
  // The promise's resolved value cannot prove the guard: exitResolve is a plain resolver in every
  // adapter, and resolving twice is a language no-op. So assert the contract directly with a resolver
  // that counts -- this is the property the guard exists to enforce, and the only one it can be
  // observed through.
  const calls: AgentExit[] = [];
  const session = { exitSettled: false, exitResolve: (e: AgentExit) => { calls.push(e); } };

  settleExit(session, { code: 0, signal: null, reason: 'cancelled' });
  settleExit(session, { code: 1, signal: null, reason: 'failed' });
  settleExit(session, { code: null, signal: 'SIGKILL', reason: 'terminated' });

  assert.equal(calls.length, 1, 'settleExit must call the resolver exactly once');
  assert.equal(calls[0].reason, 'cancelled', 'the FIRST observation must win');
  assert.equal(session.exitSettled, true);
});

test('rearmExitGate lets a retried run settle again', async () => {
  // A resumed run reuses its session object. If re-arming forgot to clear the flag, settleExit() would
  // consider the fresh run already settled and its exit promise would never resolve -- the worker would
  // hang until the stuck-run reaper intervened.
  const session = { ...createExitGate() };
  settleExit(session, { code: 0, signal: null, reason: 'completed' });
  assert.deepEqual(await session.exitPromise, { code: 0, signal: null, reason: 'completed' });

  rearmExitGate(session);
  assert.equal(session.exitSettled, false, 're-arming must clear the settled flag');

  settleExit(session, { code: 7, signal: null, reason: 'failed' });
  assert.deepEqual(await session.exitPromise, { code: 7, signal: null, reason: 'failed' });
});

test('every adapter routes exit settlement through the shared module (issue #148)', () => {
  const srcs = adapterSources();
  assert.ok(srcs.length >= 6, `expected at least six adapter files, found ${srcs.length}`);
  const bad = srcs
    .map(({ name, code }) => ({ name, hits: violations(code) }))
    .filter((r) => r.hits.length > 0);
  assert.deepEqual(
    bad,
    [],
    'adapters must not re-implement exit settlement; import it from src/adapters/exitSettlement.ts',
  );
});

test('POSITIVE CONTROL: the guard actually detects a re-implementation', () => {
  // Without this, a scanner that always returns "clean" passes the test above. Every assertion in this
  // file otherwise runs in one direction, and a one-directional set is satisfied by a broken checker.
  const offenders: Array<[string, string]> = [
    ['own function', 'function settleExit(s: Session, e: AgentExit): void { s.exitResolve(e); }'],
    ['own flag write', 'session.exitSettled = true;'],
    ['own resolver call', 'session.exitResolve({ code: 0, signal: null, reason: "completed" });'],
  ];
  for (const [label, snippet] of offenders) {
    assert.ok(violations(snippet).length > 0, `guard missed a re-implementation: ${label}`);
  }

  // ...and does not fire on the sanctioned form, nor on prose that merely quotes the forbidden code.
  assert.deepEqual(violations('settleExit(session, exit);'), []);
  assert.deepEqual(violations('rearmExitGate(session);'), []);
  assert.deepEqual(
    violations('// the old code did session.exitSettled = true and nobody caught it'),
    [],
    'comments must not trip the guard',
  );

  // The shared module is deliberately exempt -- writing the flag is ITS job. Pin that the exemption is
  // exactly one named file, so widening it cannot happen by accident.
  const names = adapterSources().map((s) => s.name);
  assert.ok(!names.includes('exitSettlement.ts'), 'the shared module must be the only exemption');
  assert.ok(names.length >= 6, 'the exemption must not swallow the adapters');
});

test('the shared module is the only place that owns the settlement logic', () => {
  const shared = readFileSync(join(ADAPTER_DIR, 'exitSettlement.ts'), 'utf8');
  assert.match(shared, /function settleExit\(/);
  // A second copy anywhere in src/ means the refactor regressed.
  const others: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); }
      else if (entry.name.endsWith('.ts') && p !== join(ADAPTER_DIR, 'exitSettlement.ts')) {
        if (/function\s+settleExit\b/.test(stripComments(readFileSync(p, 'utf8')))) others.push(p);
      }
    }
  };
  walk(new URL('../src/', import.meta.url).pathname);
  assert.deepEqual(others, [], 'settleExit() must have exactly one definition in src/');
});
