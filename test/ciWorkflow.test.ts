import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

// The policy governs everything under docs/, plus deploy/README.md and the two root documents the filter
// names. Anything else a test happens to mention is out of scope here.
const GOVERNED = /^(docs\/|deploy\/README\.md$|README\.md$|QUICKSTART\.md$)/;

const norm = (p: string) => {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};

/**
 * Which governed documents a test file actually reads, resolved to repo-relative paths.
 *
 * "Mentions the path" is the wrong signal. The first version of this test proved it three ways over:
 *   - backup.test.ts, sandbox.test.ts and workspaceGC.test.ts name README.md, but they write it into a
 *     temp workspace and assert on the copy. Those are not guards on the repo's own documents.
 *   - deployDocs.test.ts reaches README.md through `join(DEPLOY, 'README.md')`, where DEPLOY is itself a
 *     join off import.meta.dirname. Keying on a literal `join(ROOT, ...)` missed it entirely.
 *   - client/test/cli.test.ts reads docs/cli-tui-design.md through a two-level `join(import.meta.dirname,
 *     '..', '..', 'docs', ...)`. Missing that left a real document unguarded.
 *
 * So this resolves the read call's path the way the test itself would: expand import.meta.dirname against
 * the file's own directory, follow one level of const indirection, and ignore writeFileSync/existsSync.
 * Comments are stripped, because a comment naming a path is documentation about a path, not a read.
 */
function markdownPathsIn(rel: string): string[] {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const fileDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  // const DEPLOY = join(import.meta.dirname, '..', 'deploy')
  const consts = new Map<string, string>();
  for (const m of code.matchAll(/const (\w+) = join\(\s*import\.meta\.dirname((?:\s*,\s*'[^']*')*)\s*\)/g)) {
    const parts = (m[2].match(/'([^']*)'/g) || []).map((x) => '/' + x.slice(1, -1)).join('');
    consts.set(m[1], norm(`${fileDir}${parts}`));
  }

  const out = new Set<string>();
  const keep = (p: string) => {
    const resolved = norm(p);
    if (!GOVERNED.test(resolved)) return;
    if (existsSync(join(ROOT, resolved))) { out.add(resolved); return; }
    // A path that stops at an interpolation names a directory: `docs/releases/host/${v}.md`.
    const dir = resolved.replace(/\/[^/]*$/, '');
    if (dir && existsSync(join(ROOT, dir))) out.add(dir + '/');
  };

  // Take each read call's argument, then resolve whatever shape it turns out to be.
  const calls = [...code.matchAll(/\b(?:read|readFileSync|readDoc)\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => m[1]);
  for (const arg of calls) {
    const lits = [...arg.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2].replace(/\$\{[^}]*\}/g, 'x'));
    if (!lits.length) continue;
    // The encoding argument is a quoted string too: readFileSync(join(..., 'x.md'), 'utf8'). Anything
    // after the document name is not part of its path.
    const stop = lits.findIndex((x) => x.endsWith('.md'));
    const segs = stop < 0 ? lits : lits.slice(0, stop + 1);
    if (/import\.meta\.dirname/.test(arg)) {
      // import.meta.dirname itself is not a quoted literal, so every entry in lits is a real segment.
      keep(fileDir + segs.map((x) => '/' + x).join(''));
      continue;
    }
    const head = segs[0];
    // join(ROOT, 'docs', 'README.md') -- ROOT is the repo root, so the segments are already
    // repo-relative. releaseHygiene.test.ts uses this form for docs/README.md and README.md, and
    // without this branch those two reads were invisible: the coverage rule could not see that
    // docs/README.md is genuinely guarded, which is exactly the kind of blind spot this file exists
    // to close.
    if (/join\(\s*ROOT\b/.test(arg)) {
      keep(segs.join('/'));
      continue;
    }
    if (consts.has(head)) keep(consts.get(head)! + segs.slice(1).map((x) => '/' + x).join(''));
    else if (/\.md$/.test(head)) keep(head);
  }
  return [...out].sort();
}

/** A read path is triggered if a filter matches it, or matches its directory when it is one. */
function triggered(p: string): boolean {
  const globs = contractDocsGlobs();
  if (globs.some((g) => globToRegExp(g).test(p))) return true;
  if (p.endsWith('/')) return globs.some((g) => g.startsWith(p) || globToRegExp(g).test(p + 'x.md'));
  return false;
}

/** Every suite `npm test` runs. Scanning only test/ would miss client/test reading docs/. */
const SUITES = ['test', 'fleet/test', 'client/test'];

function docsReadingTests(): { file: string; paths: string[] }[] {
  const out: { file: string; paths: string[] }[] = [];
  for (const suite of SUITES) {
    const dir = join(ROOT, suite);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.test.ts')) continue;
      const paths = markdownPathsIn(`${suite}/${name}`);
      if (paths.length) out.push({ file: `${suite}/${name}`, paths });
    }
  }
  return out;
}

const contract = jobBlock('docs-contract');
const runTests = (contract.match(/node --test ([^\n]+)/) || [])[1] || '';
// Flags such as --test-timeout are part of the same line; they are not test files.
const runsFiles = runTests.split(/\s+/).filter((f) => f && !f.startsWith('-'));

test('docs-contract installs dependencies, because its tests spawn the CLI', () => {
  // #359: the job was written for tests that only read files, then inherited one that does not.
  assert.match(contract, /run: npm ci/, 'docs-contract must run `npm ci` before its tests');
  assert.match(contract, /cache: npm/, 'and it must cache, or every docs-only PR re-downloads the tree');
});

test('every test file docs-contract names exists', () => {
  assert.ok(runsFiles.length >= 3, `expected several test files in the run line, saw ${runsFiles.length}`);
  for (const f of runsFiles) assert.ok(existsSync(join(ROOT, f)), `docs-contract runs missing ${f}`);
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
