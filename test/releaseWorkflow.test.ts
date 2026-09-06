// The release workflow's tag validation, executed rather than pattern-matched.
//
// Issue #252: the `cli` branch was the only one that accepted a tag without comparing it to a manifest.
// host and fleet both do `[ "$pkg" = "$version" ] || exit 1`; `cli` did neither, so `cli-v9.9.9` produced
// a published GitHub Release whose notes described a version nobody could install.
//
// A test that asserts the workflow text "contains a version check" would pass on a check that never
// fires, and would fail on a harmless reformat. So this extracts the real shell step from the YAML and
// RUNS it against fake tags, with `gh` and `npm` stubbed on PATH. Every assertion below is about an exit
// code and a message the script actually produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

/**
 * Pull the `run: |` body out of the release workflow.
 *
 * The repo deliberately has no YAML dependency (client/test/coupling.test.ts pins the dependency set),
 * so this is indentation-based rather than a parsed document. It fails loudly if the step it is looking
 * for is not found, because a silently-empty script would make every scenario below "pass".
 */
function extractReleaseScript(): string {
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('run: |'));
  assert.ok(start >= 0, 'no `run: |` step found in release.yml; the extractor is stale');
  const keyIndent = lines[start].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.search(/\S/);
    if (indent <= keyIndent) break;
    body.push(line);
  }
  const script = body.map((l) => (l.trim() === '' ? '' : l.slice(keyIndent + 2))).join('\n');
  assert.ok(script.includes('refusing tag'),
    'the extracted step is not the tag-validation step; the extractor found the wrong `run:` block');
  assert.ok(script.includes('gh release create'),
    'the extracted step does not create the release; it is incomplete');
  return script;
}

interface Run { status: number | null; stdout: string; stderr: string }

/** Run the workflow step for one tag, in a throwaway tree with stubbed `gh` and `npm`. */
function runTag(tag: string, opts: { notes?: string[]; pkgVersion?: string } = {}): Run {
  // tempDir() registers the path with the file-level teardown in helpers.ts, which also runs when a
  // test file aborts partway -- something a per-test finally block cannot guarantee.
  const tmp = tempDir('release-step-');
  try {
    writeFileSync(join(tmp, 'package.json'),
      JSON.stringify({ name: '@aywengo/mercury', version: opts.pkgVersion ?? pkg.version }));
    writeFileSync(join(tmp, 'fleet-package-dir-marker'), '');
    mkdirSync(join(tmp, 'fleet'), { recursive: true });
    writeFileSync(join(tmp, 'fleet', 'package.json'),
      JSON.stringify({ name: '@aywengo/mercury-fleet', version: opts.pkgVersion ?? pkg.version }));
    for (const note of opts.notes ?? []) {
      mkdirSync(join(tmp, 'docs', 'releases', note.split('/')[0]), { recursive: true });
      writeFileSync(join(tmp, 'docs', 'releases', note), `# ${note}\n\nbody long enough to not be a stub.\n`);
    }

    // Stub the only two external commands the step uses, and record what it asked for.
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    for (const cmd of ['gh', 'npm']) {
      const stub = join(bin, cmd);
      writeFileSync(stub, `#!/bin/sh\necho "${cmd} $*" >> "${tmp}/calls.log"\nexit 0\n`);
      chmodSync(stub, 0o755);
    }

    const script = join(tmp, 'step.sh');
    writeFileSync(script, extractReleaseScript());
    const r = spawnSync('/bin/bash', [script], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF: `refs/tags/${tag}`, GITHUB_REF_NAME: tag },
    });
    const calls = existsSync(join(tmp, 'calls.log')) ? readFileSync(join(tmp, 'calls.log'), 'utf8') : '';
    return { status: r.status, stdout: r.stdout + calls, stderr: r.stderr };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const V = pkg.version;
const cliNotes = [`cli/${V}.md`];

test('a cli tag matching package.json is released, and publishes no npm package', () => {
  const r = runTag(`cli-v${V}`, { notes: cliNotes });
  assert.equal(r.status, 0, `expected acceptance, got exit ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, /gh release create cli-v/, 'the release was not created');
  assert.ok(!/npm publish/.test(r.stdout),
    'a cli tag must not publish; the CLI ships inside the host package');
});

test('a cli tag that does NOT match package.json is refused (issue #252)', () => {
  // The regression. Before the fix this exited 0 and published a release describing a version that no
  // published artifact carries. The notes file exists here on purpose: it proves the guard is the
  // version comparison and not the notes check doing the work by accident.
  const r = runTag('cli-v9.9.9', { notes: ['cli/9.9.9.md'] });
  assert.equal(r.status, 1, `cli-v9.9.9 against package.json ${V} should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /cli-v9\.9\.9 but package.json is/, `refusal should name both versions: ${r.stderr}`);
  assert.ok(!/gh release create/.test(r.stdout), 'a refused tag must not create a release');
});

test('host and fleet keep their existing manifest comparison', () => {
  // The cli fix must not be the only guarded path, and must not have disturbed the two that already
  // worked. Both are given their notes file so the failure can only come from the version comparison.
  const host = runTag('host-v9.9.9', { notes: ['host/9.9.9.md'] });
  assert.equal(host.status, 1, `host-v9.9.9 should still be refused, got exit ${host.status}`);
  assert.match(host.stderr, new RegExp(`package\\.json version ${V.replace(/\./g, '\\.')} != tag 9\\.9\\.9`),
    `refusal should name both versions: ${host.stderr}`);

  const fleet = runTag('fleet-v9.9.9', { notes: ['fleet/9.9.9.md'] });
  assert.equal(fleet.status, 1, `fleet-v9.9.9 should still be refused, got exit ${fleet.status}`);
  assert.match(fleet.stderr, new RegExp(`fleet/package\\.json version ${V.replace(/\./g, '\\.')} != tag 9\\.9\\.9`),
    `refusal should name both versions: ${fleet.stderr}`);
});

test('a matching host tag still publishes, so the guards did not over-tighten', () => {
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `expected acceptance, got exit ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, /npm publish --access public --provenance/, 'host must publish');
});

test('a cli tag with no notes file is still refused', () => {
  // Guards stack: the notes check must not have been weakened while adding the version check.
  const r = runTag(`cli-v${V}`, { notes: [] });
  assert.equal(r.status, 1, `missing notes should refuse, got exit ${r.status}`);
  assert.match(r.stderr, new RegExp(`missing docs/releases/cli/${V.replace(/\./g, '\\.')}\\.md`));
});

test('a malformed tag is refused before any product logic runs', () => {
  const r = runTag('v9.9.9', { notes: [] });
  assert.equal(r.status, 1, `bare v9.9.9 should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /refusing tag v9\.9\.9/);
});
