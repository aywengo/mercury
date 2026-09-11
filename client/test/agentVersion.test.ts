// The harness version line on the two surfaces that show a Run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunDetail } from '../commands/show.ts';
import { harnessLabel } from '../../ui/app.js';

const OFF = { json: false, noColor: true, cursor: undefined } as never;

function run(extra: Record<string, unknown> = {}): never {
  return {
    id: 'run_1', ownerId: 'a', task: 'fix it', agent: 'primeagent', status: 'COMPLETED', attempt: 1,
    retryOf: null, error: null, errorKind: null, constraints: { maxDurationMs: 1, maxRetries: 0 },
    createdAt: '2026-01-01T00:00:00Z', startedAt: null, completedAt: null,
    workspaceBranch: null, workspacePath: null, leaseOwner: null, leaseExpiresAt: null,
    cancellationRequestedAt: null, finalCommits: [], prUrl: null,
    repository: { url: 'https://example.invalid/r.git' },
    ...extra,
  } as never;
}
function show(extra: Record<string, unknown> = {}): string {
  return renderRunDetail({ run: run(extra), skills: [] } as never, OFF, false);
}

test('runs show prints the harness version beside the agent', () => {
  const out = show({ agentVersion: '0.9.4', agentVersionRaw: 'prime-agent 0.9.4' });
  assert.match(out, /harness\s+0\.9\.4/);
  assert.match(out, /prime-agent 0\.9\.4/, 'the raw output is the evidence when a parse looks wrong');
  assert.match(out, /agent\s+primeagent/, 'the agent id must still be there -- different question');
});

test('runs show says unknown rather than leaving the harness blank', () => {
  // A blank reads as "same as always" to someone skimming, which is the wrong inference when the
  // whole point is that the installed artifact may not be what main expects.
  assert.match(show(), /harness\s+version unknown/);
  assert.match(show({ agentVersion: null }), /harness\s+version unknown/);
});

test('runs show distinguishes an unparsable probe from no probe', () => {
  // One wants "fix the probe", the other wants nothing. Collapsing them loses the only hint.
  const unparsable = show({ agentVersion: null, agentVersionRaw: 'dev build' });
  assert.match(unparsable, /version unknown \(dev build\)/);
  const none = show({ agentVersion: null, agentVersionRaw: null });
  assert.ok(!none.includes('(dev build)'));
});

test('a hostile raw version string cannot inject terminal sequences', () => {
  const raw = `build\u001b[31m\u0007pwned`;
  const out = show({ agentVersion: null, agentVersionRaw: raw });
  assert.ok(!out.includes('\u001b'), `escape survived: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('\u0007'), 'BEL survived');
  assert.match(out, /pwned/, 'the data is still legible after sanitising');
});

test('harnessLabel answers the three states differently', () => {
  assert.equal(harnessLabel({ agentVersion: '1.2.3', agentVersionRaw: '1.2.3' }), '1.2.3');
  assert.equal(harnessLabel({ agentVersion: '1.2.3', agentVersionRaw: 'acme 1.2.3' }), '1.2.3 (acme 1.2.3)');
  assert.equal(harnessLabel({ agentVersion: null, agentVersionRaw: 'dev build' }), 'unknown (dev build)');
  assert.equal(harnessLabel({ agentVersion: null, agentVersionRaw: null }), 'unknown');
  assert.equal(harnessLabel({}), 'unknown');
  assert.equal(harnessLabel(null), 'unknown');
  assert.equal(harnessLabel(undefined), 'unknown');
});

test('harnessLabel never invents a version when the probe failed', () => {
  // The failure mode this guards is assume-yes in a version badge: showing the newest known
  // version because nothing was detected is how #459 looked.
  const out = harnessLabel({ agentVersion: null, agentVersionRaw: 'nonsense' });
  assert.ok(!/\d/.test(out.split('(')[0]), `a version appeared for an undetected harness: ${out}`);
});

test('a hostile raw string is sanitised even when the version parsed', () => {
  // The other test covers the unparsable branch. This is the second render path over the same
  // attacker-influenced field, and a field-by-field audit is exactly how one of them gets missed.
  const out = show({ agentVersion: '1.2.3', agentVersionRaw: `acme\u001b[31m\u0007pwned` });
  assert.ok(!out.includes('\u001b'), `escape survived: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('\u0007'), 'BEL survived');
  assert.match(out, /1\.2\.3/, 'the version is still shown');
});
