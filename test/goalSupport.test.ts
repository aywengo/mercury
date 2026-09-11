/**
 * Goal-capability resolution (docs/goals.md section 13).
 *
 * These tests exist to pin the fail-closed rules, not the happy path. Every branch that
 * could be quietly inverted -- "unknown means probably fine", "string compare is close
 * enough" -- has a case here that fails when it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  goalCapabilityMessage,
  numericCore,
  resolveGoalCapability,
} from '../src/domain/goalSupport.ts';

test('compareVersions compares numerically per component, not lexically', () => {
  // The trap this exists for: 0.20.5 is NEWER than 0.3.3, and a string compare says the
  // opposite. Hermes reports 0.20.x, so getting this wrong would mark every real Hermes
  // install as too old (or, inverted, mark old ones current).
  assert.ok(compareVersions('0.20.5', '0.3.3') > 0, '0.20.5 must be newer than 0.3.3');
  assert.ok(compareVersions('0.3.3', '0.20.5') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.3.3', '0.3.3'), 0);
  assert.ok(compareVersions('0.2.7', '0.3.3') < 0);
  assert.ok(compareVersions('1.0.0', '0.999.999') > 0);
});

test('compareVersions treats a missing trailing component as zero', () => {
  assert.equal(compareVersions('0.3', '0.3.0'), 0);
  assert.ok(compareVersions('0.3.1', '0.3') > 0);
});

test('numericCore extracts the leading dotted run from real harness output', () => {
  // Verbatim shapes measured off the installed binaries.
  assert.deepEqual(numericCore('0.9.4'), [0, 9, 4]);
  assert.deepEqual(numericCore('Hermes Agent v0.20.5 (2026.8.19) \u00b7 upstream 933c209e'), [0, 20, 5]);
  assert.deepEqual(numericCore('1.0.3 (Claude Code)'), [1, 0, 3]);
  assert.deepEqual(numericCore('no digits at all'), []);
});

test('a backend with no declared support is unsupported regardless of version', () => {
  // Hermes has goals and Mercury cannot reach them, so its row is empty and must stay
  // "unsupported" even when a healthy version is detected. A probe result must never
  // soften a declared "never" into "unknown".
  const cap = resolveGoalCapability({}, { version: '0.20.5', raw: 'Hermes Agent v0.20.5' });
  assert.equal(cap.supported, false);
  assert.equal(cap.reason, 'unsupported');
});

test('declared support with an undetected version fails closed as version-unknown', () => {
  // The two failure modes this distinguishes from "unsupported": probe still in flight,
  // and probe that could not parse. Neither may resolve to supported -- assume-yes is
  // issue #459 -- and neither may resolve to "unsupported", which would tell the operator
  // to change agent when what they need to do is fix the probe.
  const inFlight = resolveGoalCapability({ set: '0.3.3' }, null);
  assert.equal(inFlight.supported, false);
  assert.equal(inFlight.reason, 'version-unknown');
  assert.equal(inFlight.requiredVersion, '0.3.3');

  const unparsable = resolveGoalCapability({ set: '0.3.3' }, { version: null, raw: 'dev build', error: 'unparsable' });
  assert.equal(unparsable.supported, false);
  assert.equal(unparsable.reason, 'version-unknown');
});

test('a version below the threshold is too old, at and above it is supported', () => {
  const tooOld = resolveGoalCapability({ set: '0.3.3' }, { version: '0.2.7', raw: '0.2.7' });
  assert.equal(tooOld.supported, false);
  assert.equal(tooOld.reason, 'version-too-old');
  assert.equal(tooOld.detectedVersion, '0.2.7');

  // Boundary: the threshold itself is supported. Using strict > here would reject the
  // exact version the feature shipped in.
  const exact = resolveGoalCapability({ set: '0.3.3' }, { version: '0.3.3', raw: '0.3.3' });
  assert.equal(exact.supported, true);

  const newer = resolveGoalCapability({ set: '0.3.3' }, { version: '0.9.4', raw: '0.9.4' });
  assert.equal(newer.supported, true);
});

test('the reason string names both the threshold and what was detected', () => {
  // "unsupported" alone is not actionable. The operator needs to know whether to upgrade
  // the harness, fix the probe, or drop the goal.
  const old = resolveGoalCapability({ set: '0.3.3' }, { version: '0.2.7', raw: '0.2.7' });
  const msg = goalCapabilityMessage('primeagent', old);
  assert.match(msg, /0\.3\.3/, `threshold missing from: ${msg}`);
  assert.match(msg, /0\.2\.7/, `detected version missing from: ${msg}`);

  const unknown = resolveGoalCapability({ set: '0.3.3' }, null);
  const umsg = goalCapabilityMessage('primeagent', unknown);
  assert.match(umsg, /could not be determined/, `unknown not distinguished in: ${umsg}`);
  assert.doesNotMatch(umsg, /0\.2\./, `unknown message must not invent a version: ${umsg}`);

  const never = resolveGoalCapability({}, { version: '0.20.5', raw: 'x' });
  assert.match(goalCapabilityMessage('hermes', never), /hermes does not support goals/i);
});
