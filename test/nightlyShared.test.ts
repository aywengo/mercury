// shared.ts (#769): one copy of the repo regex, date helpers and gh primitives - the guard that
// keeps the regex drift (select/next loose vs e2e/report strict, found on #768) from recurring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_RE, assertRepo, localDateString, nextDay, prevDay, readBoundedText } from '../.agents/skills/nightly/shared.ts';

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

test('#980: readBoundedText reports truncation and cancels the stream at the cap', async () => {
  const enc = new TextEncoder();
  const big = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('a'.repeat(100)));
      c.enqueue(enc.encode('b'.repeat(100)));
      c.close();
    },
  });
  const r = await readBoundedText(big, 150);
  assert.equal(r.truncated, true, 'the body did not end before the cap: the text is a prefix');
  assert.ok(r.text.length >= 150 && r.text.length <= 200, 'the read stops at the cap (plus at most the chunk that crossed it)');
  assert.ok(r.text.startsWith('a'.repeat(100)), 'the kept text is an intact prefix of the body');
  // A body that ends before the cap is complete: not truncated, whole text.
  const small = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('abc'));
      c.close();
    },
  });
  assert.deepEqual(await readBoundedText(small, 16), { text: 'abc', truncated: false });
  // The cap is BYTES: 17 two-byte characters are 34 bytes, well past a 16-byte cap.
  const multi = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('é'.repeat(17))); // 34 bytes
      c.close();
    },
  });
  const r2 = await readBoundedText(multi, 16);
  assert.equal(r2.truncated, true, 'the byte cap, not the character count, decides');
});
