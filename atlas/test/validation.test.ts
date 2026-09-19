import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, validateDraft, claimHash } from '../validation.ts';
import type { NoteDraft } from '../types.ts';

test('validation: scope grammar', () => {
  // Valid scopes
  assert.deepEqual(parseScope('project'), { ok: true, kind: 'project' });
  assert.deepEqual(parseScope('repo:0123456789abcdef'), { ok: true, kind: 'repo', hash: '0123456789abcdef' });
  assert.deepEqual(parseScope('repo:0123456789abcdef#src/queue'), { ok: true, kind: 'repo', hash: '0123456789abcdef', path: 'src/queue' });
  assert.deepEqual(parseScope('agent:myagent'), { ok: true, kind: 'agent', agent: 'myagent' });
  assert.deepEqual(parseScope('agent:agent-01'), { ok: true, kind: 'agent', agent: 'agent-01' });
  
  // Invalid scopes
  assert.deepEqual(parseScope('repo:ZZZ'), { ok: false });
  assert.deepEqual(parseScope('repo:0123456789abcdef#/etc/passwd'), { ok: false });
  assert.deepEqual(parseScope('repo:0123456789abcdef#a/../b'), { ok: false });
  assert.deepEqual(parseScope('agent:'), { ok: false });
  assert.deepEqual(parseScope('unknown:scope'), { ok: false });
});

test('validation: closed kinds', () => {
  const validKinds = ['fact', 'convention', 'pitfall', 'command', 'decision', 'artifact-pointer'];
  for (const kind of validKinds) {
    // pitfall and decision require evidence, so provide it
    const evidence = (kind === 'pitfall' || kind === 'decision') ? [{ type: 'issue', url: 'https://example.com/issue/1' }] : [];
    const result = validateDraft({
      kind,
      scope: 'project',
      claim: 'test claim',
      evidence,
    }, { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 });
    assert.ok(result.ok, `${kind} should be valid: ${result.ok ? '' : result.reason}`);
  }
  
  const result = validateDraft({
    kind: 'invalid-kind',
    scope: 'project',
    claim: 'test claim',
    evidence: [],
  }, { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 });
  assert.ok(!result.ok);
  assert.equal(result.reason, 'invalid-kind');
});

test('validation: decision and pitfall require evidence', () => {
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  
  // Decision without evidence: should fail
  const decision = validateDraft({
    kind: 'decision',
    scope: 'project',
    claim: 'we chose X',
    evidence: [],
  }, bounds);
  assert.ok(!decision.ok);
  assert.equal(decision.reason, 'missing-evidence');
  
  // Pitfall without evidence: should fail
  const pitfall = validateDraft({
    kind: 'pitfall',
    scope: 'project',
    claim: 'something goes wrong',
    evidence: [],
  }, bounds);
  assert.ok(!pitfall.ok);
  assert.equal(pitfall.reason, 'missing-evidence');
  
  // Other kinds without evidence: should pass
  for (const kind of ['fact', 'convention', 'command', 'artifact-pointer']) {
    const result = validateDraft({
      kind,
      scope: 'project',
      claim: 'test claim',
      evidence: [],
    }, bounds);
    assert.ok(result.ok, `${kind} should not require evidence`);
  }
});

test('validation: claim over maxClaimBytes is rejected, not truncated', () => {
  const bounds = { maxClaimBytes: 10, maxDetailBytes: 4096, maxEvidence: 8 };
  
  // "test" is 4 bytes; should pass
  const short = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'test',
    evidence: [],
  }, bounds);
  assert.ok(short.ok);
  
  // Multi-byte character: "你好世界" is 3 bytes each = 12 bytes total, over 10
  const multiByte = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: '你好世界',
    evidence: [],
  }, bounds);
  assert.ok(!multiByte.ok);
  assert.equal(multiByte.reason, 'claim-too-long');
});

test('validation: claim_hash equivalence', () => {
  // Same claim with different whitespace and punctuation should hash the same
  const hash1 = claimHash('fact', 'project', 'the integration tests need docker compose running');
  const hash2 = claimHash('fact', 'project', 'the  integration   tests  need docker compose running.');
  const hash3 = claimHash('fact', 'project', 'the  integration   tests  need docker compose running!');
  assert.equal(hash1, hash2);
  assert.equal(hash2, hash3);
  
  // Different kind, scope, or claim should produce different hashes
  const hashDiffKind = claimHash('convention', 'project', 'the integration tests need docker compose running');
  const hashDiffScope = claimHash('fact', 'repo:0123456789abcdef', 'the integration tests need docker compose running');
  const hashDiffClaim = claimHash('fact', 'project', 'something different');
  
  assert.notEqual(hash1, hashDiffKind);
  assert.notEqual(hash1, hashDiffScope);
  assert.notEqual(hash1, hashDiffClaim);
});

test('validation: K2 override accepts an operator exception that names the fired rule', () => {
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const claim = 'Run with --skill planning to analyze';

  const refused = validateDraft({ kind: 'fact', scope: 'project', claim, evidence: [] }, bounds);
  assert.ok(!refused.ok);
  assert.equal(refused.reason, 'k2-violation');

  const allowed = validateDraft(
    { kind: 'fact', scope: 'project', claim, evidence: [] },
    bounds,
    { k2Override: { rule: 'harness-flag', reason: 'verified by hand against the repo skill' } },
  );
  assert.ok(allowed.ok, JSON.stringify(allowed));
  assert.deepEqual((allowed as { draft: { operatorOverride?: unknown } }).draft.operatorOverride, {
    rule: 'harness-flag',
    reason: 'verified by hand against the repo skill',
  });
});

test('validation: an override that names no fired rule, or fires nothing, is invalid-override', () => {
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  // Nothing fired, override present: an exception nobody granted is not recordable.
  const nothing = validateDraft(
    { kind: 'fact', scope: 'project', claim: 'migrations are appended, never edited', evidence: [] },
    bounds,
    { k2Override: { rule: 'harness-flag', reason: 'nothing fired' } },
  );
  assert.ok(!nothing.ok);
  assert.equal(nothing.reason, 'invalid-override');

  // Fired, but the override names a different rule than the one that fired.
  const wrong = validateDraft(
    { kind: 'fact', scope: 'project', claim: 'Check ~/.hermes/profiles/x for details', evidence: [] },
    bounds,
    { k2Override: { rule: 'harness-flag', reason: 'wrong rule' } },
  );
  assert.ok(!wrong.ok);
  assert.equal(wrong.reason, 'invalid-override');
  assert.match((wrong as { detail?: string }).detail ?? '', /harness-home/);

  // Missing or empty or over-long reason.
  for (const reason of [undefined, '', '   ', 'x'.repeat(bounds.maxClaimBytes + 1)]) {
    const bad = validateDraft(
      { kind: 'fact', scope: 'project', claim: 'Run with --skill planning to analyze', evidence: [] },
      bounds,
      { k2Override: { rule: 'harness-flag', reason: reason as string } },
    );
    assert.ok(!bad.ok, `reason ${JSON.stringify(reason)?.slice(0, 20)} must be refused`);
    assert.equal(bad.reason, 'invalid-override');
  }
});

test('validation: K2 scan rejects harness-specific content', () => {
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  
  // Should reject harness home directory paths
  const hermespath = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'Check ~/.hermes/profiles/x for details',
    evidence: [],
  }, bounds);
  assert.ok(!hermespath.ok);
  assert.equal(hermespath.reason, 'k2-violation');
  
  // Should reject harness flags
  const skillFlag = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'Run with --skill planning to analyze',
    evidence: [],
  }, bounds);
  assert.ok(!skillFlag.ok);
  assert.equal(skillFlag.reason, 'k2-violation');
  
  const modelFlag = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'Use --model claude-opus-4-5',
    evidence: [],
  }, bounds);
  assert.ok(!modelFlag.ok);
  assert.equal(modelFlag.reason, 'k2-violation');
  
  // Should reject short flag
  const shortFlag = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'Use -s planning skill',
    evidence: [],
  }, bounds);
  assert.ok(!shortFlag.ok);
  assert.equal(shortFlag.reason, 'k2-violation');
  
  // Should allow legitimate knowledge (product names and skill names in prose)
  const legitimate1 = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'The ClaudeCodeAdapter sends the task over stdin',
    evidence: [],
  }, bounds);
  assert.ok(legitimate1.ok, 'should allow product names in prose');
  
  const legitimate2 = validateDraft({
    kind: 'fact',
    scope: 'project',
    claim: 'Migrations are appended to MIGRATIONS, never edited',
    evidence: [],
  }, bounds);
  assert.ok(legitimate2.ok, 'should allow legitimate project knowledge');
});
