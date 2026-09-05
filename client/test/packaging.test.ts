// Packaging guard (docs/cli-tui-design.md §12, M4 territory pulled forward).
//
// Found in review: `bin.mercuryctl` was added pointing at client/bin.ts while `files` remained an
// allowlist that named only src/ and friends. npm always ships files named by `bin`, so the tarball
// contained client/bin.ts and NOTHING ELSE from client/ -- an installed mercuryctl that dies on its
// first import. The failure only appears after `npm install`, which no test in this repo does, so the
// invariant is asserted against package.json directly instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('every bin entry exists in the repository', () => {
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    assert.ok(existsSync(join(ROOT, target)), `bin ${JSON.stringify(name)} -> ${target} does not exist`);
  }
});

test('every bin entry is covered by the published files allowlist', () => {
  const files: string[] | undefined = pkg.files;
  // No allowlist means npm ships everything except its own ignores, which is safe by construction.
  if (!files) return;
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    const dir = dirname(target);
    // A bin target is reachable if `files` names its directory (or '.'), or names an ancestor of it.
    // Checking the directory rather than the single file matters: bin.ts imports its siblings, and an
    // allowlist that shipped only the entry point produced exactly the broken install described above.
    // Coverage means the DIRECTORY (or an ancestor of it) is published. Naming only the entry point is
    // deliberately NOT coverage: that is precisely the state that shipped, where npm auto-included
    // client/bin.ts and nothing else it imports. An allowlist entry pointing at a file inside the
    // directory must not be mistaken for publishing the directory.
    const covered = files.some((entry) => {
      const e = entry.replace(/\/+$/, '');
      if (e === '' || e === '.') return true;
      return dir === e || dir.startsWith(e + sep);
    });
    assert.ok(
      covered,
      `bin ${JSON.stringify(name)} -> ${target} lives in ${JSON.stringify(dir)}, which "files" ` +
        `(${JSON.stringify(files)}) does not include. npm would ship the entry point alone and the ` +
        `installed command would fail on its first import.`,
    );
  }
});

test('the published file list does not silently drop a client source directory', () => {
  // The specific regression, stated directly, so a future edit to "files" that removes client/ fails
  // with a message about mercuryctl rather than a generic allowlist mismatch.
  const files: string[] | undefined = pkg.files;
  if (!files) return;
  const clientSources = new Set<string>();
  // Enumerate the real tree rather than trusting a hardcoded list, so adding a subdirectory under
  // client/ is automatically covered.
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        clientSources.add(relative(ROOT, full).split(sep)[1] ?? '');
      }
    }
  };
  collect(join(ROOT, 'client'));
  clientSources.delete('test');
  assert.ok(clientSources.size > 0, 'no client sources found; this assertion would be vacuous');
  const included = files.some((entry) => entry.replace(/\/+$/, '') === 'client');
  assert.ok(
    included,
    `"files" does not include client/, so these would not be published: ${[...clientSources].join(', ')}`,
  );
});
