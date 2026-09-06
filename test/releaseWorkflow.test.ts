// The release workflow's tag validation, executed rather than pattern-matched.
//
// Issue #252 added a manifest comparison to the `cli` branch, which was the only one accepting a tag
// unchecked. That branch has since been removed entirely: a cli tag published a GitHub Release and no
// artifact, so the whole pattern was dropped rather than kept and guarded. What remains here is the
// proof that host and fleet still compare tags to their manifests, and that cli is refused outright.
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
    // The fleet branch copies LICENSE into fleet/ before publishing. Without it the fleet PUBLISH path
    // could not be exercised at all -- the only pre-existing fleet test asserted a version mismatch,
    // which exits before the cp, so the gap stayed invisible.
    writeFileSync(join(tmp, 'LICENSE'), 'MIT\n');
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

test('a cli tag is refused outright, even one matching package.json', () => {
  // The cli release stream was removed. A cli-vX.Y.Z tag created a GitHub Release and published no
  // artifact, because the CLI ships inside @aywengo/mercury and has no version of its own -- so the tag
  // announced a version nobody could install. Nothing was ever tagged (no tags, no releases, nothing on
  // npm at the time of removal), so dropping the pattern strands nothing.
  //
  // The version-matching tag is the case that matters: it is the one the old code ACCEPTED. Notes are
  // supplied so the refusal can only come from the tag pattern, not from a missing notes file.
  const r = runTag(`cli-v${V}`, { notes: [`cli/${V}.md`] });
  assert.equal(r.status, 1, `cli-v${V} should be refused now, got exit ${r.status}`);
  assert.match(r.stderr, /refusing tag cli-v/, `expected a tag-pattern refusal: ${r.stderr}`);
  assert.ok(!/gh release create/.test(r.stdout), 'a refused tag must not create a release');
  assert.ok(!/npm publish/.test(r.stdout), 'a refused tag must not publish');
});

test('the workflow tag filter no longer admits cli', () => {
  // The regex above is what rejects an already-triggered run, but the `on.push.tags` filter decides
  // whether the workflow runs at all. Both must drop cli, or a cli tag still starts a job that fails
  // instead of never starting. Asserted on the filter block, not the whole file, so a comment that
  // mentions cli cannot satisfy it.
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'tags:');
  assert.ok(start >= 0, 'no `tags:` filter found in release.yml; the extractor is stale');
  const filter = lines.slice(start + 1).filter((l) => /^\s*-\s+'/.test(l));
  assert.ok(filter.length >= 2, `tag filter looks truncated: ${JSON.stringify(filter)}`);
  assert.ok(!filter.some((l) => l.includes('cli')),
    `the tag filter still admits a cli pattern: ${JSON.stringify(filter)}`);
  // Both directions: dropping cli must not have dropped a product that still releases.
  assert.ok(filter.some((l) => l.includes('host-v')), 'host tag pattern missing from the filter');
  assert.ok(filter.some((l) => l.includes('fleet-v')), 'fleet tag pattern missing from the filter');
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

test('a host tag with no notes file is still refused', () => {
  // The notes check must stay live for the products that do release. It used to be asserted through a
  // cli tag; cli is now refused at the tag pattern, before the notes check is ever reached, so that
  // path would prove nothing. host is a product that actually publishes, so assert on it.
  const r = runTag(`host-v${V}`, { notes: [] });
  assert.equal(r.status, 1, `missing notes should refuse, got exit ${r.status}`);
  assert.match(r.stderr, /missing docs\/releases\/host\//);
  assert.ok(!/gh release create/.test(r.stdout), 'a tag with no notes must not create a release');
});

test('a prerelease host tag is accepted and published under dist-tag rc, not latest', () => {
  // The whole point of the RC work. npm applies `latest` to ANY version published without --tag
  // (`npm config get tag` prints "latest"), so publishing 0.1.0-rc1 the old way would have made
  // `npm install @aywengo/mercury` resolve to the release candidate for everyone. The stubbed npm on
  // PATH records the exact argv, so this asserts the flag the real publish would carry.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `a prerelease tag matching package.json must be accepted: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`gh release create host-v${V.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /npm publish [^\n]*--tag rc\b/,
    `prerelease must publish under dist-tag rc, got:\n${r.stdout}`);
  assert.ok(!/--tag latest/.test(r.stdout), 'a prerelease must NOT be published under latest');
});

test('a stable version still publishes under latest', () => {
  // Both directions: routing prereleases to rc must not have moved stable releases off latest.
  const r = runTag('host-v1.2.3', { notes: ['host/1.2.3.md'], pkgVersion: '1.2.3' });
  assert.equal(r.status, 0, `stable tag should be accepted: ${r.stderr}`);
  assert.match(r.stdout, /npm publish [^\n]*--tag latest\b/,
    `stable must publish under latest, got:\n${r.stdout}`);
});

test('a prerelease fleet tag publishes fleet under rc too', () => {
  const r = runTag('fleet-v2.0.0-beta.3', { notes: ['fleet/2.0.0-beta.3.md'], pkgVersion: '2.0.0-beta.3' });
  assert.equal(r.status, 0, `fleet prerelease should be accepted: ${r.stderr}`);
  assert.match(r.stdout, /npm publish [^\n]*--tag beta\b/,
    `fleet beta must publish under beta, got:\n${r.stdout}`);
});

test('a prerelease with no alphabetic identifier publishes under next, never latest', () => {
  // 1.0.0-1 has a numeric identifier, so stripping digits yields an empty string. Publishing that
  // would mean `npm publish --tag ""`. The workflow falls back to `next`; without the fallback the
  // empty tag would either error or, worse, be dropped and leave npm on its `latest` default.
  const r = runTag('host-v1.0.0-1', { notes: ['host/1.0.0-1.md'], pkgVersion: '1.0.0-1' });
  assert.equal(r.status, 0, `should be accepted: ${r.stderr}`);
  assert.match(r.stdout, /npm publish [^\n]*--tag next\b/,
    `numeric-only prerelease must use next, got:\n${r.stdout}`);
  assert.ok(!/--tag latest/.test(r.stdout), 'a prerelease must never reach latest');
});

test('a prerelease tag that disagrees with package.json is still refused', () => {
  // The #252 invariant must survive prerelease support: loosening the tag pattern must not loosen the
  // manifest comparison, or 0.1.0-rc9 would publish against a package that says 0.1.0-rc1.
  const r = runTag('host-v0.9.9-rc1', { notes: ['host/0.9.9-rc1.md'] });
  assert.equal(r.status, 1, `mismatched prerelease should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /package\.json version/);
  assert.ok(!/gh release create/.test(r.stdout), 'a refused tag must not create a release');
});

test('a malformed tag is refused before any product logic runs', () => {
  const r = runTag('v9.9.9', { notes: [] });
  assert.equal(r.status, 1, `bare v9.9.9 should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /refusing tag v9\.9\.9/);
});
