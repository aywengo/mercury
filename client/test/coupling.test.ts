import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The coupling rule (docs/cli-tui-design.md §11.1, §15.4).
//
// The client must not import anything from src/ or fleet/, not even TypeScript types. The reason is
// not stylistic: importing a type is free today and catastrophic later, because it drags the remote
// client's dependency graph onto the worker runtime -- database, queue, adapters -- so a tool an
// operator installs on a laptop to watch a Run suddenly needs server configuration to exist.
//
// The stated trade-off is a deliberate wire-type copy in client/api/protocol.ts. That copy can drift,
// and drift is made VISIBLE by this guard plus contract tests against the real API. Shared imports
// would make drift invisible while quietly destroying independent deployment.

const CLIENT_DIR = new URL('..', import.meta.url).pathname;
const FORBIDDEN = [/(?:^|[./])src\//, /(?:^|[./])fleet\//];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/**
 * Every form of module reference that could reach across the boundary.
 *
 * `import ... from '...'`, bare `import '...'`, `export ... from '...'`, dynamic `import('...')`,
 * and `require('...')`. Checking only static `import` would miss the dynamic form, which is exactly
 * how an accidental cross-boundary dependency would be added under time pressure -- and a guard that
 * is trivially bypassed by the one form someone is likely to use is not a guard.
 */
const SPECIFIER_RE =
  /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

test('the client tree is non-empty and actually being scanned', () => {
  const files = sourceFiles(CLIENT_DIR);
  // A guard over an empty set passes forever and proves nothing. If the client directory were
  // renamed or the glob broke, this test would go green while the rule stopped being enforced.
  assert.ok(files.length >= 5, `expected several client sources, found ${files.length}`);
  assert.ok(
    files.some((f) => f.endsWith('protocol.ts')),
    'the scan is not reaching client/api/protocol.ts',
  );
});

test('no client module imports from src/ or fleet/', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(CLIENT_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SPECIFIER_RE)) {
      const spec = match[1]!;
      if (FORBIDDEN.some((re) => re.test(spec))) {
        violations.push(`${relative(CLIENT_DIR, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `client must not depend on server or Fleet sources:\n${violations.join('\n')}`);
});

test('the guard actually reports a violation', () => {
  // A guard whose only test is "no violations" is unproven. Feed the SAME matcher a known-bad
  // specifier and require it to fire, otherwise a broken regex would silently pass forever.
  // Built at runtime so this file does not itself contain a forbidden specifier -- otherwise the
  // scanner reports its own test fixture, which is a false positive that would get the guard
  // switched off. It also proves the scanner reads file CONTENT, not real module resolution.
  const bad = ['import { Run } ', 'from ', "'../../../", 'src/', "domain/types.ts';"].join('');
  const found = [...bad.matchAll(SPECIFIER_RE)].map((m) => m[1]!);
  assert.equal(found.length, 1);
  assert.ok(
    FORBIDDEN.some((re) => re.test(found[0]!)),
    `the matcher failed to flag ${found[0]}`,
  );
  // And it must not flag legitimate specifiers, or the guard would be disabled as noise.
  for (const ok of ['node:fs', './api/errors.ts', '../exitCodes.ts', 'express']) {
    assert.ok(!FORBIDDEN.some((re) => re.test(ok)), `the matcher wrongly flags ${ok}`);
  }
});

test('the client does not read Mercury state directly', () => {
  // §3 non-goals: the client never opens the database or workspace directories. It talks HTTP.
  // The built-in SQLite module is the specific thing to forbid -- importing it would let the client
  // bypass the API, and the API is where owner scoping and secret redaction live. A client that read
  // the database directly would also silently ignore the owner scoping that keeps one operator from
  // seeing another's Runs.
  const offenders: string[] = [];
  for (const file of sourceFiles(CLIENT_DIR)) {
    const text = readFileSync(file, 'utf8');
    // Assembled at runtime for the same reason as above: this file must not contain the literal
    // module name it is looking for.
    if (text.includes(['node:', 'sqlite'].join(''))) offenders.push(relative(CLIENT_DIR, file));
  }
  assert.deepEqual(offenders, [], `client must not touch the database: ${offenders.join(', ')}`);
});
