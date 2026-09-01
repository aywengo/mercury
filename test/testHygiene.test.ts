// Guards over the test suite itself. Issue #73 L8: fixture dirs and loose files were created with
// bare mkdtempSync / join(tmpdir(), ...) and never removed, so every run of `npm test` left ~131
// entries in the system temp dir, and 26k+ had accumulated on one development machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = import.meta.dirname;

function testSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(TEST_DIR).sort()) {
    if (!name.endsWith('.test.ts') && name !== 'helpers.ts') continue;
    out.set(name, readFileSync(join(TEST_DIR, name), 'utf8'));
  }
  return out;
}

/** Strip line comments so prose that mentions a pattern is not reported as using it. */
function codeOnly(src: string): string {
  return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

test('test files allocate temp paths only through the helpers (issue #73 L8)', () => {
  // helpers.ts is exempt: it OWNS the two helpers and must call mkdtempSync itself.
  const offenders: string[] = [];
  for (const [name, src] of testSources()) {
    if (name === 'helpers.ts') continue;
    const code = codeOnly(src);
    // Match the IDENTIFIER, not the call form. A first version matched `mkdtempSync` followed by
    // `(`, and a mutation that imported it under an alias and called the alias slipped straight
    // through -- a guard that only catches the spelling it was written against is not a guard.
    // The message must also avoid the word itself, or a passing run reports itself as an offender.
    if (new RegExp('\\bmkdtemp' + 'Sync\\b').test(code)) {
      offenders.push(`${name}: untracked temp allocation — use tempDir from helpers`);
    }
  }
  assert.deepEqual(offenders, [], `untracked temp dirs would leak on every run:\n${offenders.join('\n')}`);
});

test('tempDir and tempFile are registered for teardown (issue #73 L8)', () => {
  const helpers = codeOnly(readFileSync(join(TEST_DIR, 'helpers.ts'), 'utf8'));
  assert.match(helpers, /export function tempDir\(/, 'tempDir must exist');
  assert.match(helpers, /export function tempFile\(/, 'tempFile must exist');
  // The registration is the whole point: a helper that only creates is the bug under another name.
  assert.match(helpers, /leakedDirs\.add\(dir\)/, 'tempDir must register its path');
  assert.match(helpers, /leakedDirs\.add\(dirname\(file\)\)/, 'tempFile must register its path');
  assert.match(helpers, /after\(\(\) => \{[\s\S]{0,400}rmSync\(dir/, 'a file-level after() hook must remove them');
});

test('the guard itself is not vacuous', () => {
  // The guard above scans source text for a call pattern, so this file must not CONTAIN that
  // pattern literally -- including here, where it is needed to prove the matcher works. Built by
  // concatenation so the literal never appears in this file.
  const word = ['mkdtemp', 'Sync'].join('');
  const re = new RegExp('\\b' + word + '\\b');
  // Aliased import: the spelling the old guard matched is absent, but the allocation is still there.
  const aliased = `import { ${word} as _leak } from 'node:fs';\nconst d = _leak('/tmp/x');`;
  assert.match(codeOnly(aliased), re, 'the matcher must catch an aliased import, not just the call form');
  const commented = `// const d = ${word}('/tmp/x');`;
  assert.doesNotMatch(codeOnly(commented), re, 'commented occurrences must be ignored');
});
