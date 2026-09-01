import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeSkillId, compareSkillIds, resolveContained, SkillRegistry } from '../src/skills/skillRegistry.ts';
import { writeSkills } from '../src/worker/worker.ts';
import { createSkillSelector, KEYWORDS } from '../src/skills/skillSelector.ts';
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

test('skill ids cannot escape the registry root (issue #58)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-trav-'));
  try {
    // A skill living OUTSIDE the registry root, holding content that must never be
    // readable through the registry. On the base commit resolve(['../outside']) returned
    // this directory's files -- including SECRET.txt -- so `skills: ["../../../../x"]` in
    // an API request body was an arbitrary-directory read, and writeSkills then copied
    // the whole tree into the run workspace.
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: outside\nversion: 1.0.0\ndescription: d\ncapabilities: [a]\n---\n\n# Outside\n',
    );
    writeFileSync(join(outside, 'SECRET.txt'), 'top-secret-content');
    const root = join(dir, 'registry');
    mkdirSync(join(root, 'good'), { recursive: true });
    writeFileSync(
      join(root, 'good', 'SKILL.md'),
      '---\nname: good\nversion: 1.0.0\ndescription: d\ncapabilities: [a]\n---\n\n# Good\n',
    );

    const reg = new SkillRegistry(root);
    assert.deepEqual(reg.resolve(['good']).map((s) => s.id), ['good'], 'legitimate ids must still resolve');

    for (const bad of ['../outside', '../../../../etc', '..', '../outside/', 'good/../../outside', '', '.', 'a/b']) {
      assert.throws(() => reg.resolve([bad]), /Unsafe skill id/, `expected ${JSON.stringify(bad)} to be rejected`);
    }
    // the leaked file is genuinely reachable on the filesystem, so a passing assertion
    // above means containment worked rather than the fixture being empty
    assert.equal(readFileSync(join(outside, 'SECRET.txt'), 'utf8'), 'top-secret-content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveContained refuses paths that escape the root (issue #58)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-contain-'));
  try {
    assert.equal(resolveContained(dir, 'a/b.md'), join(dir, 'a', 'b.md'));
    assert.throws(() => resolveContained(dir, '../escape'), /escapes/);
    assert.throws(() => resolveContained(dir, 'a/../../escape'), /escapes/);
    // A sibling whose name merely shares a prefix with the root is not inside it. This is
    // the classic startsWith-without-separator bug: /root-evil passes a bare
    // startsWith('/root') check but is not contained by /root.
    const nested = join(dir, 'root');
    mkdirSync(nested, { recursive: true });
    assert.throws(() => resolveContained(nested, '../root-evil'), /escapes/);
    assert.equal(assertSafeSkillId('issue-fix-loop'), 'issue-fix-loop');
    assert.throws(() => assertSafeSkillId('../x'), /Unsafe skill id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('containment survives a symlinked skills directory (issue #58, Copilot on #92)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sym-'));
  try {
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });

    // A run workspace is a git worktree of a repo that may be untrusted, and git checks
    // out symlinks happily. So `.agents/skills` itself can be a symlink, and lexical
    // containment would approve a destination whose real target is anywhere on the host.
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, '.agents'), { recursive: true });
    symlinkSync(outside, join(ws, '.agents', 'skills'));
    assert.throws(
      () => resolveContained(join(ws, '.agents', 'skills'), 'my-skill/NOTES.md'),
      /symlink/,
      'a symlinked skills root must not be followed',
    );

    // Same for an intermediate component below the root.
    const ws2 = join(dir, 'ws2');
    mkdirSync(join(ws2, '.agents', 'skills', 'real'), { recursive: true });
    symlinkSync(outside, join(ws2, '.agents', 'skills', 'link'));
    assert.throws(() => resolveContained(join(ws2, '.agents', 'skills'), 'link/NOTES.md'), /symlink|escapes/);

    // A real directory below the root is unaffected.
    assert.equal(
      resolveContained(join(ws2, '.agents', 'skills'), 'real/SKILL.md'),
      join(ws2, '.agents', 'skills', 'real', 'SKILL.md'),
    );

    // Symlinks in the root's ANCESTRY must stay allowed: on macOS /tmp is a symlink to
    // /private/tmp, so resolving only the target would reject every path under it.
    assert.equal(resolveContained(tmpdir(), 'a/b.md'), join(tmpdir(), 'a', 'b.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('containment works when the root is the filesystem root (Copilot on #92)', () => {
  // `absRoot + sep` becomes `//` when the root is `/`, so a naive prefix check rejects
  // every child of `/`. `/usr` is a real directory on macOS and Linux; `/etc` is a
  // symlink on macOS and is therefore refused, which is the safe direction.
  assert.equal(resolveContained('/', 'usr'), '/usr');
  assert.equal(resolveContained('/', 'usr/share'), '/usr/share');
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

test('short capability terms match words, not substrings (Copilot on #84)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const available = reg.list();
  // 'ui' is a frontend capability. Raw substring matching made it fire inside
  // ordinary words, so a task about test suites pulled in the frontend skill.
  assert.ok(!selector.select('fix the failing test suite', available, 4).includes('frontend'),
    'frontend matched a task whose only "ui" is inside the word "suite"');
  assert.ok(selector.select('add a settings page to the dashboard UI', available, 4).includes('frontend'),
    'frontend failed to match a task that does name the UI');
  // Longer terms stay substring-matched on purpose -- they are stems, not words.
  // Asserted with deepEqual, not includes: planning, implementation, testing and git-pr
  // are the FALLBACK set, so an `includes` check on those passes even when nothing
  // scored at all. Exact results are the only way to prove the stem actually matched.
  assert.deepEqual(selector.select('run the tests', available, 4), ['testing'],
    'testing no longer matches the stem "tests"');
  assert.deepEqual(selector.select('plan the rollout', available, 4), ['planning'],
    'planning no longer matches the stem "planning"');
  assert.deepEqual(selector.select('perform an analysis of the codebase', available, 4), ['repository-analysis'],
    'repository-analysis no longer matches the stem "analysis"');
  assert.deepEqual(selector.select('write a database migration', available, 4), ['implementation'],
    'implementation no longer matches the stem "migration"');
});

test('selector KEYWORDS and the skill registry agree (issue #79)', () => {
  const reg = new SkillRegistry(SKILLS_DIR);
  const skills = reg.list();
  const ids = new Set(skills.map((s) => s.id));

  // Stale direction. A KEYWORDS key for a skill that was renamed or deleted is never
  // consulted at runtime -- the entry is simply dead -- so nothing else can surface it.
  for (const key of Object.keys(KEYWORDS)) {
    assert.ok(ids.has(key), `KEYWORDS has an entry for unknown skill '${key}'`);
  }

  // Missing direction. A skill with neither capabilities nor a KEYWORDS entry scores 0
  // for every task, which is how #78 went unnoticed. Stated as OR because capabilities
  // are the primary signal since #78 and KEYWORDS is only an override. This overlaps
  // the #80 metadata test for the real library, but fails for a different reason: #80
  // reports bad authoring in a SKILL.md, this reports a selector that cannot reach a
  // skill even when its metadata looks fine.
  for (const skill of skills) {
    const scoreable = skill.capabilities.length > 0 || (KEYWORDS[skill.id]?.length ?? 0) > 0;
    assert.ok(scoreable, `${skill.id} has no capabilities and no KEYWORDS entry`);
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

test('writeSkills refuses a traversal skill id or file path (issue #58, review N1)', async () => {
  // The write side is the more dangerous half: the read side only leaks a listing, this
  // one places bytes. It is unreachable through the registry today, so it needs a test of
  // its own -- otherwise a refactor that feeds writeSkills from a persisted snapshot
  // instead of re-resolving ids would silently reopen #58 with nothing failing.
  const dir = mkdtempSync(join(tmpdir(), 'mercury-writeskills-'));
  try {
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    const skill = (id: string, files: Record<string, string>) => ({
      id, version: '1.0.0', description: 'd', capabilities: ['a'],
      path: join(dir, 'src', 'SKILL.md'), content: '# x', files, hash: 'h',
    });

    await assert.rejects(() => writeSkills(ws, [skill('../../pwned-id', { 'NOTES.md': 'x' })]), /Unsafe skill id|escapes/);
    await assert.rejects(() => writeSkills(ws, [skill('good', { '../../pwned-rel.md': 'x' })]), /escapes/);
    await assert.rejects(() => writeSkills(ws, [skill('good', { '../../../tmp/pwned-abs.md': 'x' })]), /escapes/);
    assert.equal(existsSync(join(dir, 'pwned-id')), false, 'nothing may land outside the workspace');
    assert.equal(existsSync(join(dir, 'pwned-rel.md')), false, 'nothing may land outside the workspace');
    assert.equal(existsSync(join(dir, '..', 'pwned-abs.md')), false, 'nothing may land outside the workspace');

    // the legitimate shape still writes, into the workspace
    await writeSkills(ws, [skill('good', { 'SKILL.md': '# good', 'refs/a.md': 'a' })]);
    assert.equal(readFileSync(join(ws, '.agents', 'skills', 'good', 'SKILL.md'), 'utf8'), '# good');
    assert.equal(readFileSync(join(ws, '.agents', 'skills', 'good', 'refs', 'a.md'), 'utf8'), 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list() never returns a directory name that resolve() would reject (issue #58, review N3)', () => {
  // Auto-selection does selector.select(task, skills.list(), 4) then skills.resolve(ids).
  // Once resolve() rejects unsafe ids, an unsafe directory name would throw out of run
  // creation -- so one stray directory would fail every run.
  const dir = mkdtempSync(join(tmpdir(), 'mercury-listfilter-'));
  try {
    const meta = (n: string) => `---\nname: ${n}\nversion: 1.0.0\ndescription: d\ncapabilities: [a]\n---\n\n# x\n`;
    for (const d of ['good', 'issue-fix-loop', 'Code-Review', 'my skill', '.hidden']) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'SKILL.md'), meta(d));
    }
    const reg = new SkillRegistry(dir);
    const listed = reg.list().map((m) => m.id);
    assert.deepEqual(listed, ['good', 'issue-fix-loop'], 'unsafe directory names must be skipped');
    // the property that actually matters: whatever list() returns, resolve() accepts
    assert.deepEqual(reg.resolve(listed).map((s) => s.id), listed, 'resolve(list()) must not throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('containment errors do not disclose absolute paths (issue #66)', () => {
  // These errors reach an HTTP client via ValidationError -> 400. The original #58 wording
  // interpolated the absolute skill root and the symlink target, which hands an attacker the
  // on-disk layout for free -- the exact thing the containment work exists to protect. Asserted
  // structurally (no leading-/ path fragment) rather than by exact wording, so rewording the
  // message cannot silently reintroduce the leak.
  const ws = mkdtempSync(join(tmpdir(), 'mercury-skilldisc-'));
  try {
    const outside = mkdtempSync(join(tmpdir(), 'mercury-skilldisc-out-'));
    writeFileSync(join(outside, 'SECRET.txt'), 'top secret');
    mkdirSync(join(ws, '.agents'), { recursive: true });
    const root = join(ws, '.agents', 'skills');
    symlinkSync(outside, root);

    const messages: string[] = [];
    assert.throws(() => resolveContained(root, 'SECRET.txt'), (err: unknown) => {
      messages.push(err instanceof Error ? err.message : String(err));
      return /symlink|escape/i.test(messages[messages.length - 1]);
    }, 'the symlinked root must still be refused');

    for (const msg of messages) {
      // Any absolute-path-looking fragment is a disclosure, including the macOS /var ->
      // /private/var form the temp dirs resolve to.
      const leak = msg.match(/(?:^|\s)\/[^\s"']+/);
      assert.ok(!leak, `error message discloses an absolute path: ${msg}`);
      assert.ok(!msg.includes(ws), `error message discloses the workspace path: ${msg}`);
      assert.ok(!msg.includes(outside), `error message discloses the symlink target: ${msg}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
