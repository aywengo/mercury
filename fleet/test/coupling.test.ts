import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

/**
 * The coupling rule from docs/fleet-design.md section 11: Fleet must not import anything from Mercury's
 * src/. It speaks HTTP and nothing else, so that it can talk to a Mercury it did not build and a Mercury
 * that has moved on since.
 *
 * The detection logic is a pure function over (path, source) pairs rather than inline filesystem walking,
 * so that it can be shown to REPORT a violation. A guard whose only test is "no violations found" has never
 * been seen to fire, and is indistinguishable from a guard that cannot fire.
 */

const FLEET_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(FLEET_DIR, '..');

/** Fleet declares no runtime dependencies; the honest reading of an empty set is "Fleet needs only Node". */
const ALLOWED_BARE_SPECIFIERS = new Set<string>([]);

export interface SourceEntry {
  /** Absolute path of the file the source came from; only used to resolve relative specifiers. */
  path: string;
  source: string;
}

/** Every module specifier a file mentions: static imports, re-exports, dynamic imports and require. */
export /**
 * Blank out comments so the scan reads code, not prose.
 *
 * Without this the guard reports false positives on ordinary English -- a doc comment saying the code
 * distinguishes one thing "from 'something else'" looks exactly like an import to a regex. False positives are
 * cheap once and expensive forever: a guard that cries wolf gets ignored, and this one exists to be trusted.
 * Strings are left intact, because a real import is never only inside a comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  source = stripComments(source);
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // `export { x } from './y.ts'` reaches the same modules an import does.
    /\bexport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) found.push(match[1]!);
  }
  // Deduplicated: `export { x } from './y.ts'` matches both the generic from-pattern and the export
  // pattern, and one module reached twice is still one violation.
  return [...new Set(found)];
}

/** Returns one human-readable string per coupling violation. Empty means the boundary holds. */
export function findViolations(entries: SourceEntry[], fleetDir = FLEET_DIR): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    const rel = relative(REPO_ROOT, entry.path) || entry.path;
    for (const spec of specifiersOf(entry.source)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolve(dirname(entry.path), spec);
        const relTo = relative(fleetDir, target);
        const insideFleet = relTo === '' || !relTo.startsWith('..');
        if (!insideFleet) violations.push(`${rel}: imports ${spec}, which resolves outside fleet/`);
        continue;
      }
      if (!ALLOWED_BARE_SPECIFIERS.has(spec.split('/')[0]!)) {
        violations.push(`${rel}: imports bare specifier ${spec}, which Fleet does not declare`);
      }
    }
  }
  return violations;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function realEntries(): SourceEntry[] {
  return sourceFiles(FLEET_DIR).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

test('fleet/ contains the files Phase 0 says it should', () => {
  const files = sourceFiles(FLEET_DIR).map((f) => relative(FLEET_DIR, f)).sort();
  for (const expected of ['cli.ts', 'config.ts', 'credentials.ts', 'db.ts', 'probe.ts', 'prober.ts', 'registry.ts']) {
    assert.ok(files.includes(expected), `missing fleet/${expected}`);
  }
});

/**
 * Build a source line that mentions a module, WITHOUT writing one out literally in this file.
 *
 * This file lives in the tree the guard scans. Written as ordinary import statements, the fixtures below
 * would be genuine matches for the pattern under test and the guard would report its own test file as a
 * violation -- which is exactly what happened, twice, until the fixtures were assembled at runtime.
 */
const Q = "'";
const FROM = 'fr' + 'om';
const IMPORT = 'im' + 'port';
const REQUIRE = 'req' + 'uire';
const EXPORT = 'ex' + 'port';
/** A path that lands in Mercury src/, joined at runtime so no literal occurrence exists in this file. */
const OUTSIDE = ['..', '..', 'src', 'runs', 'runStore.ts'].join('/');
const OUTSIDE_CFG = ['..', '..', 'src', 'config.ts'].join('/');

const importLine = (spec: string): string => [IMPORT, ' { RunStore } ', FROM, ' ', Q, spec, Q].join('');
const requireLine = (spec: string): string => ['const x = ', REQUIRE, '(', Q, spec, Q, ')'].join('');
const exportLine = (spec: string): string => [EXPORT, ' { loadConfig } ', FROM, ' ', Q, spec, Q].join('');
const bareImport = (pkg: string): string => [IMPORT, ' express ', FROM, ' ', Q, pkg, Q].join('');

test('the detection logic reports a violation into Mercury src/', () => {
  // Without this test the next assertion is unfalsifiable: it would report green whether or not the
  // detector could see anything.
  const bad = join(FLEET_DIR, 'probe.ts');
  const violations = findViolations([{ path: bad, source: importLine(OUTSIDE) }]);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0]!, /resolves outside fleet\//);
});

test('the detection logic reports an undeclared dependency and a deep reach', () => {
  const bad = join(FLEET_DIR, 'registry.ts');
  const violations = findViolations([
    { path: bad, source: bareImport('express') },
    { path: bad, source: requireLine(OUTSIDE_CFG) },
    { path: bad, source: exportLine(OUTSIDE_CFG) },
  ]);
  assert.equal(violations.length, 3, violations.join('\n'));
  assert.match(violations.join('\n'), /bare specifier express/);
  assert.equal(violations.filter((v) => /resolves outside fleet\//.test(v)).length, 2,
    'the require() and the re-export must each be reported');
});

test('the detection logic permits node builtins and intra-fleet imports', () => {
  const ok = join(FLEET_DIR, 'probe.ts');
  const violations = findViolations([
    { path: ok, source: `import { DatabaseSync } from 'node:sqlite';` },
    { path: ok, source: `import type { ProbeRecord } from './registry.ts';` },
    { path: join(FLEET_DIR, 'test', 'x.test.ts'), source: `import { HostRegistry } from '../registry.ts';` },
  ]);
  assert.deepEqual(violations, []);
});

test('no file under fleet/ imports anything outside fleet/', () => {
  const entries = realEntries();
  assert.ok(entries.length >= 7, `expected the fleet sources to be found, saw ${entries.length}`);
  assert.deepEqual(findViolations(entries), [], 'coupling rule violated (design section 11)');
});

test('the guard sees the whole fleet tree, not a lucky subset', () => {
  // A traversal bug that silently scanned one directory would make the main assertion vacuously true.
  const scanned = realEntries().map((e) => relative(FLEET_DIR, e.path)).sort();
  for (const expected of ['cli.ts', 'db.ts', 'probe.ts', 'prober.ts', 'registry.ts', 'credentials.ts', 'config.ts']) {
    assert.ok(scanned.includes(expected), `${expected} was not scanned`);
  }
  assert.ok(scanned.some((f) => f.startsWith('test/')), 'test files must be scanned too');
});

test('Fleet adds no dependencies of its own', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  // express belongs to Mercury. If Fleet ever needs its own dependency that is a deliberate decision, not drift.
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['express']);
});

test('the guard reads imports, not prose', async () => {
  // Spelled through a variable on purpose. This file is itself scanned by the guard, and the literal token
  // sequence would be reported as a violation of the rule under test -- the scanner matches the text wherever
  // it appears, so splitting the string is not enough.
  const FROM = 'from';
  // A doc comment containing the word from followed by a quoted phrase used to be reported as an import of a
  // bare specifier. A guard that reports violations which are not violations trains people to ignore it.
  const prose = [
    `import { x } ${FROM} './bindings.ts';`,
    '/**',
    " * Distinguishes a refusal from 'we do not know'.",
    " * See also from 'src/api/routes.ts' for the upstream shape.",
    ' */',
    "export const y = 1;",
  ].join('\n');
  assert.deepEqual(findViolations([{ path: REPO_ROOT + '/fleet/prose.ts', source: prose }]), [],
    'prose must not be mistaken for a dependency');

  // The same file with a real violation must still report it, so the comment-stripping did not blind the guard.
  // Built by concatenation: this file is itself scanned by the guard, and a literal import here would be
  // reported as a violation of the very rule the test is checking.
  const real = prose + `\nimport { z } ${FROM} '../src/domain/types.ts';`;
  const found = findViolations([{ path: REPO_ROOT + '/fleet/prose.ts', source: real }]);
  assert.equal(found.length, 1, 'a genuine cross-boundary import is still caught');
  assert.match(found[0], /resolves outside fleet\//);

  // And a bare specifier in code, not comment, is still caught.
  const bare = `import express ${FROM} 'express';\nexport const y = 1;`;
  const found2 = findViolations([{ path: REPO_ROOT + '/fleet/prose.ts', source: bare }]);
  assert.equal(found2.length, 1);
  assert.match(found2[0], /bare specifier express/);
});
