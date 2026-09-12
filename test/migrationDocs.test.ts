import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Binds migration numbers claimed in planning docs to the MIGRATIONS array that actually decides
// them (issue #511).
//
// This drifted three times in a row, and the issue describing it was itself stale by one:
// crew/README.md said "five migrations" when there were seven, phase-0-issues.md proposed writing
// "seven (v1-v7)" when v8 had already landed, knowledge-base.md reserved v8 for the knowledge
// outbox and v8 was then taken by run_goals.attempted, and crew/roadmap.md still said "Add
// migration v6" long after run_goals claimed v6. Every one of those was a plan naming a number
// that prose does not own.
//
// So the docs now name the array instead of a number, and this test fails if a number comes back.

const DB_SRC = readFileSync(new URL('../src/db/database.ts', import.meta.url), 'utf8');
const README = readFileSync(new URL('../docs/crew/README.md', import.meta.url), 'utf8');
const ROADMAP = readFileSync(new URL('../docs/crew/roadmap.md', import.meta.url), 'utf8');
const ROLE_PRESETS = readFileSync(new URL('../docs/crew/role-presets.md', import.meta.url), 'utf8');
const KNOWLEDGE = readFileSync(new URL('../docs/knowledge-base.md', import.meta.url), 'utf8');

/**
 * The source of truth: MIGRATIONS is a plain array, so a migration's version is its position.
 * Counting template literals rather than parsing a constant, because there is no constant to read.
 */
function migrationCount(): number {
  const start = DB_SRC.indexOf('MIGRATIONS: string[] = [');
  const end = DB_SRC.indexOf('export const BUSY_TIMEOUT_MS', start);
  assert.notEqual(start, -1, 'MIGRATIONS array not found in src/db/database.ts -- did it get renamed?');
  assert.notEqual(end, -1, 'end of the MIGRATIONS block not found');
  const body = DB_SRC.slice(start, end);
  const n = (body.match(/^\s*`\n/gm) || []).length;
  assert.ok(n >= 1, 'parsed zero migrations; the counting pattern is stale');
  return n;
}

const DOCS: Record<string, string> = {
  'docs/crew/README.md': README,
  'docs/crew/roadmap.md': ROADMAP,
  'docs/crew/role-presets.md': ROLE_PRESETS,
  'docs/knowledge-base.md': KNOWLEDGE,
};

/**
 * Phrasings that reserve a migration for future work. Deliberately narrow: a doc describing an
 * already-shipped migration ("migration v7: agent_version") is a historical fact and must NOT be
 * flagged, so only forward-looking constructions are matched.
 */
const RESERVATION = [
  /\badd(?:ing)? (?:the )?(?:next free )?migration(?: v(\d+))?/gi,
  /\bmigration v(\d+) for\b/gi,
  /\bone migration, \*\*v(\d+)\*\*/gi,
  /\bthe next (?:free )?migration is v(\d+)/gi,
  /\bstart(?:s)? after v(\d+)/gi,
  /\bfollows the current v(\d+)/gi,
  /\bafter the current v(\d+)/gi,
];

test('planning docs never reserve a migration number that is already taken', () => {
  const shipped = migrationCount();
  const offenders: string[] = [];
  for (const [name, text] of Object.entries(DOCS)) {
    for (const re of RESERVATION) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const n = m[1] === undefined ? undefined : Number(m[1]);
        // "Add the next free migration" with no number is the correct form and passes.
        if (n !== undefined && n <= shipped) {
          offenders.push(`${name}: reserves v${n}, but v1-v${shipped} are already applied (${m[0].trim()})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `stale migration reservations:\n${offenders.join('\n')}`);
});

test('no doc claims how many migrations the schema contains', () => {
  // The claim that rotted was specifically about schema SIZE ("the schema currently has five
  // migrations"). A doc saying "one migration will be appended" or naming three specific versions
  // is not making that claim, so the pattern is scoped to size assertions rather than banning
  // every spelled-out number -- a guard that flags honest prose gets deleted rather than obeyed.
  const SIZE_CLAIM = /\b(?:has|have|currently (?:has|have)|there (?:is|are))\s+(?:currently\s+)?(?:only\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+migrations?/gi;
  const offenders: string[] = [];
  for (const [name, text] of Object.entries(DOCS)) {
    SIZE_CLAIM.lastIndex = 0;
    for (const m of text.matchAll(SIZE_CLAIM)) offenders.push(`${name}: "${m[0].trim()}"`);
  }
  assert.deepEqual(offenders, [], `docs asserting a migration count:\n${offenders.join('\n')}`);
});

test('the docs that discuss migrations point at the array instead of a number', () => {
  assert.match(README, /MIGRATIONS/, 'crew/README.md must point at the MIGRATIONS array');
  assert.match(ROADMAP, /MIGRATIONS/, 'crew/roadmap.md must point at the MIGRATIONS array');
  assert.match(ROLE_PRESETS, /MIGRATIONS/, 'crew/role-presets.md must point at the MIGRATIONS array');
});

test('the guard reports: a taken number in a doc fails rather than being skipped', () => {
  // Without this the test above could pass by matching nothing at all.
  const shipped = migrationCount();
  const poisoned = `Add migration v${shipped} for \`run_presets\`.`;
  const hits: string[] = [];
  for (const re of RESERVATION) {
    re.lastIndex = 0;
    for (const m of poisoned.matchAll(re)) {
      if (m[1] !== undefined && Number(m[1]) <= shipped) hits.push(m[0]);
    }
  }
  assert.ok(hits.length > 0, 'a doc reserving the newest taken migration must be caught');
  // And the correct phrasing must NOT be caught, or the guard would be deleted for crying wolf.
  const clean = 'Add the next free migration for `run_presets`.';
  const cleanHits: string[] = [];
  for (const re of RESERVATION) {
    re.lastIndex = 0;
    for (const m of clean.matchAll(re)) if (m[1] !== undefined) cleanHits.push(m[0]);
  }
  assert.deepEqual(cleanHits, [], 'the recommended phrasing must not be flagged');
});

test('this suite declares its document reads where the CI guard can see them', () => {
  // test/ciWorkflow.test.ts resolves the argument of each read call to decide which documents a
  // suite reads, and fails open when it cannot see one. Invisible there, this suite looks like it
  // reads no docs, nothing requires it in docs-contract, and it stops running on exactly the
  // markdown-only PRs it guards (#355).
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const doc of [...Object.keys(DOCS), 'src/db/database.ts']) {
    const rel = `../${doc}`;
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(
      new RegExp(`readFileSync\\(new URL\\(\\s*'${escaped}'`).test(self),
      `${doc} must be read through a literal path inside the readFileSync call, or `
      + 'test/ciWorkflow.test.ts cannot see that this suite reads it',
    );
  }
});
