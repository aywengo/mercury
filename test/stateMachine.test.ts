import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, isTerminal, assertTransition } from '../src/domain/stateMachine.ts';

test('valid transitions', () => {
  assert.ok(canTransition('QUEUED', 'STARTING'));
  assert.ok(canTransition('QUEUED', 'CANCELLED'));
  assert.ok(canTransition('STARTING', 'RUNNING'));
  assert.ok(canTransition('STARTING', 'FAILED'));
  assert.ok(canTransition('RUNNING', 'NEEDS_INPUT'));
  assert.ok(canTransition('NEEDS_INPUT', 'RUNNING'));
  assert.ok(canTransition('RUNNING', 'COMPLETED'));
  assert.ok(canTransition('RUNNING', 'TIMED_OUT'));
  assert.ok(canTransition('NEEDS_INPUT', 'CANCELLED'));
});

test('invalid transitions rejected', () => {
  assert.ok(!canTransition('QUEUED', 'COMPLETED'));
  assert.ok(!canTransition('COMPLETED', 'RUNNING'));
  assert.ok(!canTransition('NEEDS_INPUT', 'COMPLETED'));
  assert.ok(!canTransition('STARTING', 'NEEDS_INPUT'));
  assert.throws(() => assertTransition('QUEUED', 'COMPLETED'), /Invalid transition/);
});

test('terminal statuses', () => {
  for (const s of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']) {
    assert.ok(isTerminal(s as never));
  }
  assert.ok(!isTerminal('RUNNING'));
});
