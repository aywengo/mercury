import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginResumedAttempt, settleExit, rearmExitGate, createExitGate } from '../src/adapters/exitSettlement.ts';
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

// ---- #997: a resumed attempt must not inherit the previous attempt's observations ----------

/** A stand-in for a child process: records listener churn and stream teardown. */
function fakeProc() {
  const log: string[] = [];
  const stream = (name: string) => ({
    removeAllListeners(ev?: string) { log.push(`${name}.remove:${ev ?? '*'}`); },
    on(ev: string) { log.push(`${name}.on:${ev}`); },
    destroy() { log.push(`${name}.destroy`); },
  });
  return {
    log,
    proc: {
      removeAllListeners(ev?: string) { log.push(`proc.remove:${ev ?? '*'}`); },
      on(ev: string) { log.push(`proc.on:${ev}`); },
      stdout: stream('stdout'),
      stderr: stream('stderr'),
    },
  };
}

test('beginResumedAttempt clears the previous attempt\'s exit, stdout and drain state (#997)', () => {
  // #997: resume() re-armed the exit gate but left `exitInfo` and `stdoutEnded` set from the previous
  // process. settleWhenDrained() needs BOTH, so the first late event from that process settled the
  // resumed session on the previous attempt's exit while the new child was still starting.
  const { proc } = fakeProc();
  const timer = setTimeout(() => {}, 60_000);
  timer.unref?.();
  const session = {
    ...createExitGate(),
    proc,
    exitInfo: { code: 0, signal: null },
    stdoutEnded: true,
    drainTimer: timer,
  };
  settleExit(session, { code: 0, signal: null, reason: 'completed' });
  rearmExitGate(session);

  beginResumedAttempt(session);
  assert.equal(session.proc, null, 'the previous child is detached');
  assert.equal(session.exitInfo, null, 'the previous exit must not settle the resumed attempt');
  assert.equal(session.stdoutEnded, false, 'the new child has not ended its stdout yet');
  assert.equal(session.drainTimer, null, 'a pending grace timer would settle the new attempt early');
});

test('beginResumedAttempt detaches the previous child, so its late events cannot touch the new attempt (#997)', () => {
  // Clearing the fields alone is not enough: a late 'close' from the old process would set
  // stdoutEnded = true again and defeat the #166 drain guard for the NEW child. Both halves are
  // asserted here, because either one alone leaves a hole.
  const { proc, log } = fakeProc();
  const session = {
    ...createExitGate(),
    proc,
    exitInfo: { code: 1, signal: null },
    stdoutEnded: true,
    drainTimer: null,
  };
  beginResumedAttempt(session);

  for (const ev of ['exit', 'close', 'error']) {
    assert.ok(log.includes(`proc.remove:${ev}`), `the old child's ${ev} listener must be removed`);
  }
  for (const stream of ['stdout', 'stderr']) {
    for (const ev of ['data', 'end', 'error']) {
      assert.ok(log.includes(`${stream}.remove:${ev}`), `the old ${stream} ${ev} listener must be removed`);
    }
  }
  // A destroyed stream can still emit 'error'; an unhandled one is an uncaught exception that would
  // take the worker down over a run that already settled.
  assert.ok(log.includes('proc.on:error'), 'a no-op error listener replaces the removed one');
  assert.ok(log.includes('stdout.on:error') && log.includes('stderr.on:error'));
  // No reader left on a still-running previous child would block it forever on a full pipe.
  assert.ok(log.includes('stdout.destroy') && log.includes('stderr.destroy'), 'the abandoned pipes are released');
});

test('every stdio adapter detaches on resume (structural, #997)', () => {
  // The same bug existed in three adapters with a byte-identical resume() preamble, which is the
  // pattern exitSettlement.ts was created to stop repeating. A new stdio adapter that spawns in
  // resume() without this call reintroduces #997 for its backend.
  const stdio = adapterSources().filter(({ code }) => {
    const live = stripComments(code);
    return live.includes('async resume(') && live.includes('spawnProcess(');
  });
  assert.ok(stdio.length >= 3, `expected at least three stdio adapters, found ${stdio.map((s) => s.name).join(', ')}`);
  const missing = stdio.filter(({ code }) => !stripComments(code).includes('beginResumedAttempt(session)')).map((s) => s.name);
  assert.deepEqual(missing, [], 'a stdio adapter resumes without beginResumedAttempt(); see #997');
});
