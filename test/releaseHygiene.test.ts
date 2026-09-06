import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { HOST_PRODUCT, HOST_VERSION } from '../src/version.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
};

function latestChangelogVersion(text: string): string | undefined {
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])[0];
}

function spawnCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('LICENSE is MIT with the project copyright', () => {
  const license = read('LICENSE');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Roman Melnyk/);
});

test('community files exist with the expected headings', () => {
  assert.match(read('CONTRIBUTING.md'), /^# Contributing to Mercury/m);
  assert.match(read('SECURITY.md'), /https:\/\/github\.com\/aywengo\/mercury\/security\/advisories/);
  assert.match(read('CODE_OF_CONDUCT.md'), /Contributor Covenant/);
});

test('root package.json is the public host package', () => {
  assert.equal(pkg.name, '@aywengo/mercury');
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'MIT');
  // Was 'src/cli.ts', which is unrunnable once installed: Node refuses to strip types under
  // node_modules, so the published `mercury` command exited 1 before printing anything (issue #243).
  // The server is compiled to dist/ by prepack like the client. Existence is not asserted here because
  // the core suite runs without a build; client/test/packaging.test.ts builds and runs the artifact.
  assert.equal(pkg.bin?.mercury, 'dist/src/cli.js');
  assert.ok(!pkg.bin!.mercury.endsWith('.ts'), 'a bin target in TypeScript cannot run once installed');
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files whitelist must be present');
  for (const entry of pkg.files!) {
    assert.notEqual(entry, 'test/');
    assert.notEqual(entry, 'fleet/');
    assert.ok(!entry.startsWith('test/'), `files must not ship tests, got ${entry}`);
    assert.ok(!entry.startsWith('fleet/'), `files must not ship Fleet, got ${entry}`);
  }
});

test('HOST_VERSION equals package.json and the host changelog', () => {
  assert.equal(HOST_VERSION, pkg.version);
  assert.equal(HOST_PRODUCT, 'host');
  const heading = latestChangelogVersion(read('CHANGELOG.md'));
  assert.equal(heading, pkg.version, `CHANGELOG.md latest version ${heading} != ${pkg.version}`);
  assert.ok(existsSync(join(ROOT, 'docs', 'releases', 'host', `${pkg.version}.md`)),
    `docs/releases/host/${pkg.version}.md must exist`);
});

test('the CLI release stream exists and agrees with package.json', () => {
  // This was "there is no CLI release stream yet", asserting docs/releases/cli/ stayed empty until
  // mercuryctl existed. mercuryctl exists, so the guard had become a lock on a door that should open --
  // and a `cli-v*` tag would still have failed the release workflow. Replaced rather than deleted, so
  // the directory is now checked for the thing that actually matters: a `cli-vX.Y.Z` tag resolves to
  // docs/releases/cli/X.Y.Z.md, so a version with no notes file must not be able to drift into being
  // taggable.
  const cliDir = join(ROOT, 'docs', 'releases', 'cli');
  assert.ok(existsSync(cliDir), 'docs/releases/cli/ must exist now that mercuryctl is published');
  const notes = join(cliDir, `${pkg.version}.md`);
  assert.ok(existsSync(notes), `docs/releases/cli/${pkg.version}.md must exist for a cli-v${pkg.version} tag`);

  const text = read(`docs/releases/cli/${pkg.version}.md`);
  assert.match(text, new RegExp(`mercuryctl ${pkg.version.replace(/\./g, '\\.')}`),
    'the CLI notes must name the version they describe');
  // The release workflow creates the GitHub release from this file alone, so an empty or stub file would
  // produce a published release with nothing in it.
  assert.ok(text.length > 500, `docs/releases/cli/${pkg.version}.md looks like a stub (${text.length} bytes)`);
  // A test count in a file that is never re-checked starts rotting the moment a test is added, and the
  // release body is generated from this file alone. The CI run for the tag is the record of what passed.
  assert.ok(!/\b\d{3,}\s+tests\b/i.test(text),
    'the CLI notes quote a test count; that number goes stale silently, so state the checks instead');
  // The client ships in the host package, so its version is the package version -- there is no independent
  // CLI version to keep in sync, and the notes must not imply one.
  assert.ok(!/cli-v\d+\.\d+\.\d+/.test(text),
    'the CLI notes name a specific cli-v tag; the version is owned by package.json');
});

test('mercury --version prints mercury-host <version> and does not start a server', async () => {
  const r = await spawnCli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `mercury-host ${HOST_VERSION}\n`);
  assert.doesNotMatch(r.stdout, /fleet/);
});

test('releasing.md does not describe the CLI as future or reserved', () => {
  // #245: docs/releasing.md gained a correct "## The CLI" section in #242 but kept the opening line and
  // product table written before mercuryctl existed, so the same page said the CLI both exists and does
  // not. These are steps an operator follows while cutting a release, so a stale one causes a wrong action.
  const doc = read('docs/releasing.md');
  const stale: RegExp[] = [
    /future\s+`?mercuryctl`?/i,
    /`cli-vX\.Y\.Z`\s+reserved/,
    /reserved until [`']?mercuryctl/i,
    /\|\s*none yet\s*\|/,
  ];
  for (const pattern of stale) {
    assert.ok(!pattern.test(doc), `releasing.md still claims the CLI does not exist: ${pattern}`);
  }
});

test('the CLI product row states the facts a releaser needs', () => {
  const doc = read('docs/releasing.md');
  const row = doc.split('\n').find((l) => /^\|\s*CLI\s*\|/.test(l));
  assert.ok(row, 'the product table must keep a CLI row');
  const cells = row.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  assert.equal(cells.length, 5, `CLI row must keep all five columns, got ${cells.length}: ${row}`);
  // The client ships inside @aywengo/mercury, so there is no separate manifest to bump. The row used to
  // leave this blank as "none yet", which hid the one fact a CLI release depends on.
  assert.match(cells[1], /package\.json/, 'the CLI version comes from the root package.json');
  assert.match(cells[2], /cli-vX\.Y\.Z/);
  assert.ok(!/reserved/i.test(cells[2]), 'the cli tag is live, not reserved');
  assert.match(cells[3], /host package|@aywengo\/mercury/, 'the CLI ships in the host package, not its own');
  assert.match(cells[4], /docs\/releases\/cli/, 'the notes column must name the notes path');
});

test('step 6 says which products publish, so a CLI tag does not promise a package', () => {
  const doc = read('docs/releasing.md');
  const start = doc.indexOf('6. [');
  assert.ok(start >= 0, 'the release procedure must keep its numbered step 6');
  const step6 = doc.slice(start, doc.indexOf('The `NPM_TOKEN`', start) > start ? doc.indexOf('The `NPM_TOKEN`', start) : start + 900);
  // The workflow publishes for host and fleet only. Saying it publishes "for that product" reads as all
  // three, so someone cutting a cli tag waits for a package that is never coming.
  assert.match(step6, /host/, 'step 6 must name the products that publish');
  assert.match(step6, /fleet/);
  assert.match(step6, /cli/i);
  assert.match(step6, /no npm publish|does not publish|publish(es|ing)? nothing|no separate/i,
    'step 6 must state that a cli tag publishes nothing');
});

test('release.yml states the real CLI policy instead of denying the CLI exists', () => {
  const wf = read('.github/workflows/release.yml');
  // The branch echoed this to stderr on every cli tag while continuing, so it told the person cutting the
  // release that the thing they were releasing did not exist. Same shape as the guard #242 replaced.
  assert.ok(!/reserved until [`']?mercuryctl exists/i.test(wf),
    'release.yml still prints that the CLI does not exist');
  assert.match(wf, /no separate npm package/i, 'the cli branch must state the actual policy');
});

test('releasing.md does not claim the cli tag check is missing', () => {
  // #251 documented this as a known gap and #252 closed it. A doc that still says the check is absent
  // is worse than no doc: an operator would skip the check they actually have to satisfy, or distrust
  // a refusal the workflow correctly raises. Asserted in both directions, so re-opening the gap would
  // have to re-introduce the stale sentence deliberately.
  const doc = read('docs/releasing.md');
  for (const stale of [/but not\nfor `cli`/i, /not for `cli`/i, /known gap/i,
                       /the notes file, not a version comparison/i]) {
    assert.ok(!stale.test(doc), `releasing.md still describes the cli version check as missing: ${stale}`);
  }
  assert.match(doc, /for `cli`\s*\n?that manifest is the root `package\.json`|root `package\.json`, because the CLI ships/,
    'releasing.md must say which manifest a cli tag is checked against');
});
