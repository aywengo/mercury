import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSkillIds, SkillRegistry } from '../src/skills/skillRegistry.ts';
import { createSkillSelector } from '../src/skills/skillSelector.ts';
import { SKILLS_DIR } from './helpers.ts';

test('registry lists all skills', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const list = reg.list();
  const ids = list.map((s) => s.id).sort(compareSkillIds);
  // Add a skill directory -> add its id here. Exact enumeration is deliberate: a
  // derived expectation moves with the registry and cannot see a skill added, dropped,
  // or losing its SKILL.md. Discovery logic itself is not covered here -- see #79.
  assert.deepEqual(ids, [
    'code-review', 'debugging', 'deployment', 'documentation', 'frontend', 'git-pr',
    'implementation', 'issue-fix-loop', 'planning', 'repository-analysis',
    'security-review', 'testing',
  ]);
});

test('registry orders ids with the canonical comparator (issue #81)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const ids = reg.list().map((s) => s.id);
  // Assert the order production actually produces. Re-sorting before comparing,
  // as this test used to, hides a registry that sorts with a different comparator.
  assert.deepEqual(ids, [...ids].sort(compareSkillIds));
  // Pin the comparator to code-unit order using only locale-free values.
  // Array.sort() with no comparator is specified as UTF-16 code-unit order, and
  // compareSkillIds is plain `<`, so both sides are deterministic everywhere.
  // This assertion used to also check what localeCompare returned for the same
  // pair; that value varies with locale and ICU build, so the test could fail in CI
  // while the production comparator was correct.
  const tricky = ['a_b', 'a-b', 'a.b', 'a1', 'aB', 'aa', 'ab'];
  assert.deepEqual([...tricky].sort(compareSkillIds), [...tricky].sort());
  assert.equal(compareSkillIds('a-b', 'a_b'), -1);
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

test('every skill declares usable metadata (issue #80)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const list = reg.list();
  assert.ok(list.length > 0, 'registry found no skills at all');
  for (const skill of list) {
    // readMeta() returns {} when the frontmatter block fails to parse, so every
    // field silently falls back to a default -- version '0.0.0', empty description,
    // empty capabilities -- and the suite stayed green. Empty capabilities also make
    // a skill unscoreable by the selector, so a mistyped `---` fence could quietly
    // take a skill out of rotation. Assert for all skills, not just one.
    const where = `${skill.id} (SKILL.md metadata)`;
    assert.match(skill.version, /^\d+\.\d+\.\d+$/, `${where}: version must be semver, got '${skill.version}'`);
    assert.notEqual(skill.version, '0.0.0', `${where}: version is the missing-frontmatter default`);
    // Trimmed checks, not bare length checks. parseFrontmatter() turns
    // `capabilities: []` into [''] -- the bracket-list branch splits without the
    // .filter(Boolean) the plain-string branch has -- and leaves
    // `description: "   "` as three spaces. Both passed a `.length > 0` guard while
    // being unusable (Copilot on #83).
    assert.ok(skill.description.trim().length > 0, `${where}: description is empty or whitespace-only`);
    assert.ok(skill.capabilities.length > 0, `${where}: capabilities is empty`);
    for (const capability of skill.capabilities) {
      assert.ok(capability.trim().length > 0, `${where}: capability entry is blank`);
    }
  }
});

test('every skill is reachable by automatic selection (issue #78)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const available = reg.list();
  assert.ok(available.length > 0, 'registry found no skills');
  for (const skill of available) {
    // A task that names a skill's own capabilities must be able to select it.
    // Scoring used to come only from a KEYWORDS map keyed by skill id, so a skill
    // with no entry scored 0 against every task and could never be picked -- four of
    // twelve were unreachable, silently. Capabilities are now the primary signal.
    const task = `please handle: ${skill.capabilities.join(', ')}`;
    const picked = selector.select(task, available, available.length);
    assert.ok(picked.includes(skill.id), `${skill.id} unreachable for task: ${task}`);
  }
});

test('a skill does not score on a task that never mentions it (issue #78)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const available = reg.list();
  // Guards the other half of the bug. Scoring once added +0.5 for any term found in
  // the skill's own id/description/capabilities. That term does not depend on the
  // task, so it was a per-skill constant: enough terms and every skill scored on
  // every task, which ranked verbose metadata above relevance.
  const picked = selector.select('zzz qqq nothing matches this at all', available, 4);
  for (const id of ['frontend', 'deployment', 'documentation', 'security-review']) {
    assert.ok(!picked.includes(id), `${id} scored on a task that never mentions it`);
  }
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
