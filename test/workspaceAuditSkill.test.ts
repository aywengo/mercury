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
  // The referenced skill must exist in the shipped registry — a template pointing at a renamed
  // or deleted skill would fail at create time on the host.
  const reg = new SkillRegistry(join(ROOT, '.agents', 'skills'));
  const ids = reg.list().map((s) => s.id);
  for (const id of req.skills ?? []) assert.ok(ids.includes(id), `template references unknown skill '${id}'`);
  // The audit is read-only by contract: the skill text must say so.
  const skill = readFileSync(join(ROOT, '.agents', 'skills', 'workspace-audit', 'SKILL.md'), 'utf8');
  assert.match(skill, /READ-ONLY/i, 'the audit skill must declare itself read-only');
});
