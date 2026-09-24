import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCreateRunRequest } from '../client/api/protocol.ts';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';

const ROOT = join(import.meta.dirname, '..');

test('the workspace-audit dispatch template validates and references a live skill (B0-6, #734)', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'deploy', 'nightly', 'workspace-audit.json'), 'utf8'));
  // The template is exactly what `mercuryctl runs create --file` accepts: the same validator the
  // client runs before sending. A malformed template fails here, not on a host at 03:00.
  const req = validateCreateRunRequest(raw);
  assert.equal(req.skills?.length, 1);
  // Pin the intended skill, not just "some skill": the template exists to dispatch THIS skill.
  assert.equal(req.skills?.[0], 'workspace-audit');
  // The referenced skill must exist in the shipped registry — a template pointing at a renamed
  // or deleted skill would fail at create time on the host.
  const reg = new SkillRegistry(join(ROOT, '.agents', 'skills'));
  const ids = reg.list().map((s) => s.id);
  for (const id of req.skills ?? []) assert.ok(ids.includes(id), `template references unknown skill '${id}'`);
  // The audit is read-only by contract: the skill must DECLARE read-only and must not negate it
  // (a "not READ-ONLY" phrase would otherwise satisfy the match while breaking the contract).
  const skill = readFileSync(join(ROOT, '.agents', 'skills', 'workspace-audit', 'SKILL.md'), 'utf8');
  assert.match(skill, /\bREAD-ONLY\b/, 'the audit skill must declare itself read-only');
  assert.doesNotMatch(skill, /\bnot\s+read-only\b/i, 'the read-only declaration must not be negated');
});
