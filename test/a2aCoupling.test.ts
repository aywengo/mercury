// The A2A coupling guard (docs/a2a-design.md sections 10.3 and 11 decision 3, A0-1 #986).
//
// The SDK is confined to the A2A boundary: "Imported only by the A2A boundary module (and from A3,
// the `a2a` adapter). `RunService`, the worker, the store and the native routes never see an SDK
// type." That rule is what keeps an SDK upgrade from being a rewrite of the runtime, so it is
// asserted rather than remembered.
//
// Asserted in three directions, because "confined" has three failure modes:
// - an SDK import from anywhere under src/ other than src/a2a/ (the rule as written);
// - an SDK import from the client, which ships INSIDE this package (`files` in package.json) and
//   would therefore become a runtime dependency of every install;
// - the dependency drifting off its exact pin, which is what makes an upgrade deliberate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = '@a2a-js/sdk';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const A2A_DIR = 'src/a2a/';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

const SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Every module specifier a file names, comments stripped first: a comment that mentions an import
 *  is prose, and failing the suite for prose is how a guard gets deleted. */
function specifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  return [...code.matchAll(SPECIFIER_RE)].map((m) => m[1]!);
}

function importsSdk(file: string): boolean {
  return specifiers(file).some((spec) => spec === SDK || spec.startsWith(`${SDK}/`));
}

function rel(file: string): string {
  return relative(ROOT, file).split('\\').join('/');
}

test('the A2A boundary directory is non-empty and actually being scanned', () => {
  const files = sourceFiles(join(ROOT, 'src', 'a2a'));
  assert.ok(files.length >= 5, `expected the A2A boundary modules, scanned ${files.length}`);
  assert.ok(files.some((f) => importsSdk(f)), 'no scanned file imports the SDK -- the scan is not looking where the import is');
});

test('the SDK is imported only from the A2A boundary', () => {
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    if (!importsSdk(file)) continue;
    const path = rel(file);
    assert.ok(
      path.startsWith(A2A_DIR),
      `${path} imports '${SDK}'. The SDK is confined to the A2A boundary (docs/a2a-design.md section 11, decision 3): RunService, the worker, the store and the native routes never see an SDK type. Put the translation in src/a2a/ and pass plain values across the seam.`,
    );
  }
});

test('no other package in this repository reaches the SDK', () => {
  // `client/` ships inside @aywengo/mercury (`files` in package.json), so an SDK import there is a
  // runtime dependency of every install; `fleet/` and `atlas/` are separate published packages with
  // their own dependency lists. `test/` is deliberately not scanned: a test may exercise the SDK
  // directly, and the spike's evidence tests do.
  for (const dir of ['client', 'fleet', 'atlas']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      assert.ok(!importsSdk(file), `${rel(file)} imports '${SDK}': it is confined to src/a2a/ (docs/a2a-design.md section 11, decision 3)`);
    }
  }
});

test('the SDK version is pinned exactly, in package.json and the lockfile', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const pinned = pkg.dependencies[SDK];
  assert.ok(pinned, `package.json must declare ${SDK} as a runtime dependency`);
  assert.match(pinned, /^\d+\.\d+\.\d+$/, `'${pinned}' is a range: the SDK is pinned to an EXACT version so an upgrade is deliberate (docs/a2a-design.md section 11, decision 3)`);
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.packages[`node_modules/${SDK}`]?.version, pinned, 'the lockfile must resolve the same exact version package.json pins');
});
