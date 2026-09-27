// shared.ts (#769): one copy of the repo regex, date helpers and gh primitives - the guard that
// keeps the regex drift (select/next loose vs e2e/report strict, found on #768) from recurring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_RE, assertRepo, localDateString, nextDay, prevDay } from '../.agents/skills/nightly/shared.ts';

const NIGHTLY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'skills', 'nightly');

test('assertRepo: alphanumeric-leading segments only; dot-leading names and traversal refused', () => {
  assert.doesNotThrow(() => assertRepo('aywengo/mercury'));
  assert.doesNotThrow(() => assertRepo('o1/mercury-ai.dev'));
  assert.throws(() => assertRepo('..'), /owner\/name/);
  assert.throws(() => assertRepo('octo-org/.github'), /owner\/name/, 'dot-leading repo refused');
  assert.throws(() => assertRepo('.hidden/repo'), /owner\/name/);
  assert.throws(() => assertRepo('owner/name/extra'), /owner\/name/);
  assert.throws(() => assertRepo('owner/name?x=y'), /owner\/name/);
  assert.throws(() => assertRepo(''), /owner\/name/);
});

test('date helpers: calendar arithmetic on the LABEL, not the current time', () => {
  assert.equal(nextDay('2026-02-28'), '2026-03-01');
  assert.equal(prevDay('2026-03-01'), '2026-02-28');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(prevDay('2027-01-01'), '2026-12-31');
  // Leap year:
  assert.equal(nextDay('2024-02-28'), '2024-02-29');
  // The label math is timezone-neutral (noon UTC anchors), unlike Date-now arithmetic.
  assert.equal(localDateString(new Date(2026, 8, 27, 6, 5)), '2026-09-27');
});

test('drift guard: no nightly script defines its own assertRepo/ghGet/ghPost/localDateString anymore', () => {
  for (const f of ['select.ts', 'next.ts', 'e2e.ts', 'report.ts']) {
    const src = readFileSync(join(NIGHTLY_DIR, f), 'utf8');
    // Thin POLICY wrappers over the shared primitives are fine; what must not come back is the
    // fetched plumbing (the GitHub headers, the token helper, the regex, the date math).
    for (const dup of ['function assertRepo', 'function ghToken(', 'function localDateString', 'x-github-api-version']) {
      assert.ok(!src.includes(dup), `${f} still defines ${dup} locally - import it from shared.ts (#769)`);
    }
    assert.ok(src.includes("from './shared.ts'"), `${f} must import the shared helpers`);
  }
  // The strict regex is the ONLY one: no nightly script may carry a looser inline copy.
  for (const f of ['select.ts', 'next.ts', 'e2e.ts', 'report.ts']) {
    const src = readFileSync(join(NIGHTLY_DIR, f), 'utf8');
    assert.ok(!/\^\[A-Za-z0-9_\.\-\]\+\\\/\[A-Za-z0-9_\.\-\]\+\$/.test(src), `${f} carries a loose inline repo regex`);
  }
});
