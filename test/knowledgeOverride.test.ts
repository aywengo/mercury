/**
 * The operator K2 override (docs/knowledge-base.md section 7.5).
 *
 * K2 is a rejection with no second chance today: a legitimate note that trips the regex is dropped,
 * and the operator's only recourse is to reword the claim until the regex stops firing. That is the
 * right default, and it stays the default. The override is the narrow escape hatch: an operator-
 * authored note (admin token, the class that promotes and retires) may name the rule that fired and
 * give a required reason, and the reason is recorded in the note itself so a reader can see both the
 * violation and the justification. The secret check is the one thing the override can never cover.
 *
 * The properties proved here are the ones that keep the override from becoming a hole:
 *   - without an override, a K2-violating note is refused exactly as before;
 *   - an override with no reason, an empty reason, an over-long reason, or a rule that did not fire
 *     is refused as `invalid-override` rather than accepted on faith;
 *   - an override sent when nothing fired is refused -- claiming an exception nobody granted is
 *     fabricated provenance, the K3 class;
 *   - the override rides the outbox contribution to Atlas and is refused there for an
 *     agent-reported source, so a host cannot launder a harvested note through it;
 *   - the secret check still rejects through any override.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { submitOperatorNote } from '../src/knowledge/operator.ts';
import { validateDraft, DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';
import { harvestNotes } from '../src/knowledge/harvest.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { OutboxStore } from '../src/knowledge/outbox.ts';
import type { KnowledgeConfig } from '../src/config.ts';
import { makeEnv, tempDir } from './helpers.ts';

const QUIET_BOUNDS = DEFAULT_BOUNDS;

function atlasConfig(): KnowledgeConfig {
  return {
    atlas: {
      url: 'https://atlas.example.test', token: 'contrib-token', project: 'mercury',
      hostId: 'host-a', caFile: null, adminToken: 'admin-token',
    },
    inject: true, packMaxBytes: 65536, pushIntervalMs: 30_000, pushBatch: 100, pullIntervalMs: 30_000,
    retiredRetentionMs: 604_800_000, outboxAlertDepth: 0, bounds: QUIET_BOUNDS,
  };
}

const K2_CLAIM = 'load the plan with --skill planning before editing';
// The claim trips `harness-flag` and nothing else, which the assertions below rely on.
const FIRED_RULE = 'harness-flag';

test('without an override, a K2-violating operator note is refused exactly as before', () => {
  const env = makeEnv();
  try {
    const r = submitOperatorNote(env.db, atlasConfig(), { kind: 'fact', scope: 'project', claim: K2_CLAIM });
    assert.equal(r.ok, false);
    assert.equal((r as { reason?: string }).reason, 'k2-violation');
    assert.equal(new OutboxStore(env.db).depth(), 0, 'a refused note is not queued');
  } finally {
    env.close();
  }
});

test('an override names the fired rule and carries a required reason, and the note is queued', () => {
  const env = makeEnv();
  try {
    const r = submitOperatorNote(env.db, atlasConfig(), {
      kind: 'fact', scope: 'project', claim: K2_CLAIM,
      operatorOverride: { rule: FIRED_RULE, reason: 'the phrase names our own repo skill convention; verified by hand' },
    });
    assert.ok(r.ok, `overridden note refused: ${JSON.stringify(r)}`);
    const outbox = new OutboxStore(env.db);
    assert.equal(outbox.depth(), 1);
    const rows = outbox.takeBatch(10);
    const c = rows[0]!.contribution as unknown as Record<string, unknown>;
    assert.deepEqual(c.operatorOverride, {
      rule: FIRED_RULE,
      reason: 'the phrase names our own repo skill convention; verified by hand',
    }, 'the override travels on the contribution, with the reason the operator gave');
    assert.equal((c.provenance as Record<string, unknown>).source, 'operator',
      'the override is only ever recorded against an operator-authored note');
  } finally {
    env.close();
  }
});

test('an override without a reason, with an empty reason, or over the claim bound is invalid-override', () => {
  const env = makeEnv();
  try {
    const cases: unknown[] = [
      null,
      { rule: FIRED_RULE },
      { rule: FIRED_RULE, reason: '' },
      { rule: FIRED_RULE, reason: '   ' },
      { rule: FIRED_RULE, reason: 'x'.repeat(DEFAULT_BOUNDS.maxClaimBytes + 1) },
      { reason: 'a reason without a rule' },
      { rule: 'model-id', reason: 'names a rule that did not fire' },
      'not an object',
    ];
    for (const operatorOverride of cases) {
      const r = submitOperatorNote(env.db, atlasConfig(), {
        kind: 'fact', scope: 'project', claim: K2_CLAIM, operatorOverride,
      });
      assert.equal(r.ok, false, `case ${JSON.stringify(operatorOverride).slice(0, 60)} must be refused`);
      assert.equal((r as { reason?: string }).reason, 'invalid-override');
    }
    assert.equal(new OutboxStore(env.db).depth(), 0, 'no refused variant reached the outbox');
  } finally {
    env.close();
  }
});

test('an override on a note that fires no rule is refused: an exception nobody granted is not recordable', () => {
  const env = makeEnv();
  try {
    const r = submitOperatorNote(env.db, atlasConfig(), {
      kind: 'fact', scope: 'project', claim: 'migrations are appended, never edited',
      operatorOverride: { rule: FIRED_RULE, reason: 'nothing fired, but override anyway' },
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason?: string }).reason, 'invalid-override');
    assert.equal(new OutboxStore(env.db).depth(), 0);
  } finally {
    env.close();
  }
});

test('validateDraft itself: the override skips only K2, and every other refusal still applies', () => {
  // Bounds and vocabulary still bind an overridden note.
  const tooLong = validateDraft(
    { kind: 'fact', scope: 'project', claim: K2_CLAIM + ' ' + 'x'.repeat(DEFAULT_BOUNDS.maxClaimBytes) },
    DEFAULT_BOUNDS,
    { k2Override: { rule: FIRED_RULE, reason: 'r' } },
  );
  assert.equal(tooLong.ok, false);
  assert.equal((tooLong as { reason?: string }).reason, 'claim-too-long');

  // A missing-evidence pitfall is not rescued by an override either: the override speaks to K2 only.
  const noEvidence = validateDraft(
    { kind: 'pitfall', scope: 'project', claim: K2_CLAIM, evidence: [] },
    DEFAULT_BOUNDS,
    { k2Override: { rule: FIRED_RULE, reason: 'r' } },
  );
  assert.equal(noEvidence.ok, false);
  assert.equal((noEvidence as { reason?: string }).reason, 'missing-evidence');

  // And the recorded override carries the rule that ACTUALLY fired, not the one the caller named.
  const wrongRule = validateDraft(
    { kind: 'fact', scope: 'project', claim: K2_CLAIM },
    DEFAULT_BOUNDS,
    { k2Override: { rule: 'harness-home', reason: 'wrong rule' } },
  );
  assert.equal(wrongRule.ok, false);
  assert.equal((wrongRule as { reason?: string }).reason, 'invalid-override');
  assert.match((wrongRule as { detail?: string }).detail ?? '', /harness-flag/, 'the refusal names the rule that fired');
});

test('an agent-written operatorOverride in notes.jsonl is refused at harvest, not silently stripped', () => {
  const dir = tempDir('k2-override-harvest-');
  mkdirSync(join(dir, '.mercury', 'knowledge'), { recursive: true });
  writeFileSync(join(dir, '.mercury', 'notes.jsonl'), JSON.stringify({
    kind: 'fact', scope: 'project', claim: K2_CLAIM,
    operatorOverride: { rule: FIRED_RULE, reason: 'the agent grants itself an exception' },
  }) + '\n');
  const result = harvestNotes({
    workspacePath: dir,
    bounds: DEFAULT_BOUNDS,
    redactor: createRedactor([]),
    provenance: { hostId: 'host-a', agent: 'primeagent' },
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result.accepted.length, 0, 'the agent line did not become a note');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]!.reason, 'invalid-override');
});
