import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Suite hygiene: a test file that contains no tests must not look green.
 *
 * This exists because a test file was truncated to zero bytes during development and the whole suite still
 * reported every test passing with zero failures. An empty file contributes zero tests and zero failures, so
 * the only visible symptom was a total count that nobody was reading. Losing 31 tests silently is worse than a
 * red build, because a red build gets investigated.
 *
 * Deliberately NOT a pinned total: a literal count breaks for the wrong reason the moment anyone adds a test,
 * and a suite that cries wolf gets its guard deleted.
 */
const DIRS = ['test', 'fleet/test'];

function testFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

test('every test file is non-empty and declares at least one test', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const dir of DIRS) {
    for (const file of testFiles(dir)) {
      seen++;
      const source = readFileSync(file, 'utf8');
      // A file with no top-level test() call contributes nothing and fails nothing.
      const declares = /(^|\n)test\s*\(/.test(source) || /(^|\n)test\.\w+\s*\(/.test(source);
      if (source.trim().length === 0 || !declares) offenders.push(file);
    }
  }
  assert.ok(seen > 0, 'the guard itself must find the suite, or it proves nothing');
  assert.deepEqual(offenders, [], 'test files that declare no tests pass silently');
});
