import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

/**
 * The coupling rule from docs/knowledge-base.md section 11.6: Atlas must not import anything from src/ or fleet/,
 * and neither src/ nor fleet/ must import from atlas/.
 *
 * The detection logic is a pure function over (path, source) pairs rather than inline filesystem walking,
 * so that it can be shown to REPORT a violation. A guard whose only test is "no violations found" has never
 * been seen to fire, and is indistinguishable from a guard that cannot fire.
 */

const ATLAS_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(ATLAS_DIR, '..');
const SRC_DIR = resolve(REPO_ROOT, 'src');
const FLEET_DIR = resolve(REPO_ROOT, 'fleet');

/**
 * Extract a simple set of import specifiers from TypeScript source code.
 * This regex-based approach is conservative to avoid false positives.
 */
function findImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  
  // Match: import ... from "path"
  // This also catches: import { ... } from "path"
  // And: import "path"
  const importPattern = /import\s+(?:type\s+)?(?:.*?\s+)?from\s+['"](.*?)['"]|import\s+['"](.*?)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const spec = match[1] || match[2];
    if (spec) specifiers.push(spec);
  }
  
  // Match: require("path")
  const requirePattern = /require\s*\(['"](.*?)['"]\)/g;
  while ((match = requirePattern.exec(source)) !== null) {
    if (match[1]) specifiers.push(match[1]);
  }
  
  // Match: import("path")
  const dynamicPattern = /import\s*\(['"](.*?)['"]\)/g;
  while ((match = dynamicPattern.exec(source)) !== null) {
    if (match[1]) specifiers.push(match[1]);
  }
  
  return specifiers;
}

/**
 * Walk a directory tree and yield all TypeScript source files.
 *
 * Test directories are NOT skipped. The rule is that Atlas imports nothing from `src/` or `fleet/`, and
 * a test file that imported the host would break the isolation just as durably as production code -- it
 * would make `atlas/` unrunnable on its own and would let the two identity implementations drift back
 * into a shared import. Skipping `test/` was a hole wide enough to drive the whole rule through, and it
 * stayed invisible because the scan still reported zero violations.
 */
function* walkDir(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // An unreadable directory is not evidence of compliance. Skipping it would let the boundary report
    // "no violations" while a directory that cannot be opened contains any import at all, so this stops
    // the run instead of returning quietly.
    throw new Error(`coupling: cannot read directory ${dir}: ${(err as Error).message}`);
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === '.next') {
        continue;
      }
      yield* walkDir(path);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      yield path;
    }
  }
}

/** Return violations: array of { from, to, specifier } objects. */
function scanBoundary(dirToCheck: string, forbiddenPatterns: RegExp[]): Array<{ from: string; to: string; specifier: string }> {
  const violations: Array<{ from: string; to: string; specifier: string }> = [];
  
  for (const sourcePath of walkDir(dirToCheck)) {
    try {
      const source = readFileSync(sourcePath, 'utf8');
      const specifiers = findImportSpecifiers(source);
      
      for (const specifier of specifiers) {
        // Only check relative imports
        if (!specifier.startsWith('.')) {
          continue;
        }
        
        // Try to resolve the specifier
        let resolved: string;
        try {
          const baseDir = dirname(sourcePath);
          resolved = resolve(baseDir, specifier);
          
          // Try with .ts, .js extensions
          let foundPath = null;
          for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
            const candidate = resolved + ext;
            try {
              if (statSync(candidate).isFile()) {
                foundPath = candidate;
                break;
              }
            } catch {
              // not found
            }
          }
          
          if (foundPath) {
            resolved = foundPath;
          }
        } catch {
          continue;
        }
        
        // Check if it crosses a boundary
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(resolved)) {
            violations.push({
              from: relative(REPO_ROOT, sourcePath),
              to: relative(REPO_ROOT, resolved),
              specifier,
            });
            break;
          }
        }
      }
    } catch (err) {
      // A file this scanner cannot read is NOT evidence of compliance. Skipping it silently would make
      // the boundary look enforced while an unreadable file could import anything, so the failure has
      // to surface as a violation of the rule rather than as a pass.
      violations.push({
        from: relative(REPO_ROOT, sourcePath),
        to: `<unreadable: ${(err as Error).message}>`,
        specifier: '<unreadable>',
      });
    }
  }
  
  return violations;
}

test('coupling: atlas/ does not import from src/ or fleet/', () => {
  const srcPattern = new RegExp(`^${SRC_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const fleetPattern = new RegExp(`^${FLEET_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const violations = scanBoundary(ATLAS_DIR, [srcPattern, fleetPattern]);
  
  if (violations.length > 0) {
    const report = violations.map(v => `  ${v.from} imports ${v.to} (specifier: ${v.specifier})`).join('\n');
    assert.fail(`Atlas must not import from src/ or fleet/:\n${report}`);
  }
  
  assert.deepEqual(violations, []);
});

test('coupling: src/ does not import from atlas/', () => {
  const atlasPattern = new RegExp(`^${ATLAS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const violations = scanBoundary(SRC_DIR, [atlasPattern]);
  
  if (violations.length > 0) {
    const report = violations.map(v => `  ${v.from} imports ${v.to} (specifier: ${v.specifier})`).join('\n');
    assert.fail(`src/ must not import from atlas/:\n${report}`);
  }
  
  assert.deepEqual(violations, []);
});

test('coupling: fleet/ does not import from atlas/', () => {
  const atlasPattern = new RegExp(`^${ATLAS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const violations = scanBoundary(FLEET_DIR, [atlasPattern]);
  
  if (violations.length > 0) {
    const report = violations.map(v => `  ${v.from} imports ${v.to} (specifier: ${v.specifier})`).join('\n');
    assert.fail(`fleet/ must not import from atlas/:\n${report}`);
  }
  
  assert.deepEqual(violations, []);
});

test('coupling: atlas declares no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ATLAS_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  
  const dependencies = pkg.dependencies ?? {};
  assert.deepEqual(
    dependencies,
    {},
    'Atlas should declare no runtime dependencies; the honest reading of an empty set is "Atlas needs only Node"',
  );
});
