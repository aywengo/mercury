import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';
import { createSkillSelector } from '../src/skills/skillSelector.ts';
import { SKILLS_DIR } from './helpers.ts';

test('registry lists all skills', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const list = reg.list();
  const ids = list.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'code-review', 'debugging', 'deployment', 'documentation', 'frontend', 'git-pr',
    'implementation', 'planning', 'repository-analysis', 'security-review', 'testing',
  ]);
});

test('registry resolves skills with content and hash', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const [testing] = reg.resolve(['testing']);
  assert.equal(testing.id, 'testing');
  assert.equal(testing.version, '1.0.0');
  assert.ok(testing.content.includes('# Testing'));
  assert.match(testing.hash, /^[0-9a-f]{64}$/);
  assert.ok(testing.capabilities.includes('testing'));
});

test('registry throws on unknown skill', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  assert.throws(() => reg.resolve(['nope']), /Skill not found/);
});

test('automatic selection is deterministic and keyword-based', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const available = reg.list();
  const a = selector.select('Fix the failing integration tests and prepare a PR', available, 4);
  const b = selector.select('Fix the failing integration tests and prepare a PR', available, 4);
  assert.deepEqual(a, b);
  assert.ok(a.includes('testing'));
  assert.ok(a.includes('git-pr'));
});

test('automatic selection falls back when nothing matches', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const picked = selector.select('zzz qqq www', reg.list(), 4);
  assert.ok(picked.length > 0);
});
