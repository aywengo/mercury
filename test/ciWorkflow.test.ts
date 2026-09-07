import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * ci.yml decides which tests run for which files, and nothing checked that decision. Two real bugs slipped
 * through because of that, both in the same week:
 *
 *   - #355: releaseHygiene asserts claims made in docs/, but ran only in the Node matrix, which a
 *     markdown-only PR skips. A docs edit broke it and merged green.
 *   - #359: the fix for #355 moved releaseHygiene into docs-contract, a job written for tests that only
 *     read files. releaseHygiene also spawns the CLI, so it needs node_modules, which that job never
 *     installed. Every CLI test in it failed -- and the job did not run on the PR that added it, because
 *     that PR touched ci.yml, which classifies as code and skips docs-contract.
 *
 * The pattern is that a path policy is a claim about the test suite, and the claim was unchecked. These
 * tests read ci.yml and verify it against the suite as it exists on disk, so the next time a test starts
 * reading docs/ or a job loses its dependencies, the failure lands on the PR that caused it.
 *
 * A CI change cannot be exercised by the job it changes -- touching ci.yml reclassifies the PR as code and
 * skips docs-contract. That is exactly why this file belongs in the Node matrix: it is the only way a
 * ci.yml diff gets checked at all.
 */

const ROOT = join(import.meta.dirname, '..');
const CI = '.github/workflows/ci.yml';
const ci = readFileSync(join(ROOT, CI), 'utf8');

/** Slice out one job's YAML block by its two-space-indented key. */
function jobBlock(job: string): string {
  const start = ci.indexOf(`\n  ${job}:`);
  assert.ok(start >= 0, `${job} job must exist in ${CI}`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The filter list under `contract_docs:` inside the paths-filter block. */
function contractDocsGlobs(): string[] {
  const m = ci.match(/\n {12}contract_docs:\n([\s\S]*?)(?=\n {10}\S|\n {8}\S)/);
  assert.ok(m, 'the contract_docs filter must exist; docs-contract depends on it');
  return [...m[1].matchAll(/- '([^']+)'/g)].map((x) => x[1]);
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans directories, `**` alone spans anything.
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (/[.+^${}()|[\]\\]/.test(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

const covered = (p: string) => contractDocsGlobs().some((g) => globToRegExp(g).test(p));

/**
 * Every markdown path a test names literally. A template literal such as `docs/releases/${name}.md`
 * yields its static prefix (`docs/releases/`), which is exactly the granularity the coverage question
 * needs: does some filter trigger on that directory?
 */
// The policy governs a fixed set of locations: everything under docs/, deploy/README.md, and the two root
// documents the filter names.
const GOVERNED = /^(docs\/|deploy\/README\.md$|README\.md$|QUICKSTART\.md$)/;

/**
 * Which governed documents a test file actually reads.
 *
 * "Mentions the path" is the wrong signal, and the first version of this test proved it: backup.test.ts,
 * sandbox.test.ts and workspaceGC.test.ts all name README.md and deploy/README.md, but they write those
 * files into a temp workspace and assert on the copy. They would be reported as guards on the repo's own
 * README, and the rule would be wrong on three of its first four findings.
 *
 * So this keys on the read call itself -- read('docs/x.md'), readFileSync(join(ROOT, ...)) -- and ignores
 * writeFileSync, existsSync and rm. Comments are stripped first, because a comment that names a path is
 * documentation about a path, not a read of it.
 */
function markdownPathsIn(src: string): string[] {
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  const out = new Set<string>();
  const keep = (p: string) => {
    if (!p || !GOVERNED.test(p)) return;
    if (existsSync(join(ROOT, p))) { out.add(p); return; }
    // A literal that stops at an interpolation names a directory: `docs/releases/host/${v}.md`.
    const dir = p.replace(/\/[A-Za-z0-9_.-]*$/, '');
    if (dir && existsSync(join(ROOT, dir))) out.add(dir + '/');
  };
  // read('docs/status.md') and readFileSync('README.md', ...)
  for (const m of code.matchAll(/\b(?:read|readFileSync|readDoc)\(\s*['"`]([A-Za-z0-9_./-]+\.md)/g)) keep(m[1]);
  // read(`docs/releases/host/${pkg.version}.md`) -- a template literal, which is how releaseHygiene names
  // the release notes. Missing this left docs/releases/**/*.md in the filter with nothing proving it.
  for (const m of code.matchAll(/\b(?:read|readFileSync|readDoc)\(\s*`([^`]*)`/g)) {
    keep(m[1].replace(/\$\{[^}]*\}/g, 'x'));
  }
  // readFileSync(join(ROOT, 'docs', 'status.md'), ...) and the template-literal variant
  for (const m of code.matchAll(/\b(?:read|readFileSync)\(\s*join\(\s*ROOT\s*,([^)]*)\)/g)) {
    const parts = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    const tmpl = /`([^`]*)`/.exec(m[1]);
    if (tmpl) parts.push(tmpl[1].replace(/\$\{[^}]*\}/g, 'x') + (tmpl[1].endsWith('}') ? '.md' : ''));
    if (parts.length) keep(parts.join('/'));
  }
  return [...out].sort();
}

/** Test files that read a document that exists in this repo, with the paths they name. */
function docsReadingTests(): { file: string; paths: string[] }[] {
  const out: { file: string; paths: string[] }[] = [];
  for (const name of readdirSync(join(ROOT, 'test')).sort()) {
    if (!name.endsWith('.test.ts')) continue;
    const paths = markdownPathsIn(readFileSync(join(ROOT, 'test', name), 'utf8'));
    if (paths.length) out.push({ file: name, paths });
  }
  return out;
}

/** A read path is triggered if a filter matches it, or matches its directory when it is one. */
function triggered(p: string): boolean {
  const globs = contractDocsGlobs();
  if (globs.some((g) => globToRegExp(g).test(p))) return true;
  if (p.endsWith('/')) return globs.some((g) => g.startsWith(p) || globToRegExp(g).test(p + 'x.md'));
  return false;
}

const contract = jobBlock('docs-contract');
const runTests = (contract.match(/node --test ([^\n]+)/) || [])[1] || '';
// Flags such as --test-timeout are part of the same line; they are not test files.
const runsFiles = runTests
  .split(/\s+/)
  .filter((f) => f && !f.startsWith('-'))
  .map((f) => basename(f));

test('docs-contract installs dependencies, because its tests spawn the CLI', () => {
  // #359: the job was written for tests that only read files, then inherited one that does not.
  assert.match(contract, /run: npm ci/, 'docs-contract must run `npm ci` before its tests');
  assert.match(contract, /cache: npm/, 'and it must cache, or every docs-only PR re-downloads the tree');
});

test('every test file docs-contract names exists', () => {
  assert.ok(runsFiles.length >= 3, `expected several test files in the run line, saw ${runsFiles.length}`);
  for (const f of runsFiles) assert.ok(existsSync(join(ROOT, 'test', f)), `docs-contract runs missing test/${f}`);
});

test('every test that reads a real docs file runs in docs-contract', () => {
  // #355: a docs-only PR skips the Node matrix, so a test that reads docs/ and lives only there is dead
  // weight -- it cannot fail the change it guards.
  const missing = docsReadingTests()
    .filter((t) => !runsFiles.includes(t.file))
    .map((t) => `${t.file} reads ${t.paths.join(', ')}`);
  assert.deepEqual(missing, [], `these would not run on a markdown-only PR:\n${missing.join('\n')}`);
});

test('the contract_docs path filter covers every document those tests read', () => {
  // A test wired into the job is still inert if the paths it reads do not trigger the job.
  const read = new Set<string>();
  for (const t of docsReadingTests()) for (const p of t.paths) read.add(p);
  const missing = [...read].filter((p) => !triggered(p));
  assert.deepEqual(missing, [], `read but never triggered:\n${missing.join('\n')}`);
});

// Deliberately NOT asserted: that every entry in contract_docs is read by some test. The forward rule
// above can only ever see paths a test spells out, and this suite also builds them with join() and
// template literals, so a reverse assertion would flag documents that are read just fine. A guard that
// cries wolf gets deleted rather than obeyed, so the direction that cannot be measured is left alone.
