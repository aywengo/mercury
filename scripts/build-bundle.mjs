// Build the self-contained Homebrew bundle.
//
// The bundle is a prebuilt tree that vendors its production dependencies, so `brew install`
// needs no build step and no network. It is attached to the host GitHub Release and the
// Homebrew formula points at it.
//
// The staged file list is DERIVED FROM package.json "files" rather than repeated here. The
// npm tarball and the bundle must contain the same runtime tree; a second hand-maintained
// list is how the two would drift, and the drift would only appear after install.
//
// Usage: node scripts/build-bundle.mjs [--out <dir>]

import { mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// --root exists so the "files names a path that does not exist" guard below can be exercised
// against a fixture. Without it the guard can only ever be observed in a tree where every
// entry happens to be present, which proves nothing.
const rootIdx = process.argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? process.argv[rootIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : join(tmpdir(), `mercury-bundle-${pkg.version}`);

// "files" mixes includes with `!` negations. Split them; npm's own semantics for the
// negations is "do not ship this", which here means "do not stage this".
const files = pkg.files ?? [];
const includes = files.filter((f) => !f.startsWith('!'));
const excludes = files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));

const stage = join(outDir, `mercury-${pkg.version}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const missing = [];
for (const entry of includes) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) { missing.push(entry); continue; }
  cpSync(src, join(stage, entry), {
    recursive: true,
    filter: (s) => !excludes.some((x) => s.startsWith(join(ROOT, x))),
  });
}
if (missing.length) {
  console.error(`package.json "files" names paths that do not exist: ${missing.join(', ')}`);
  console.error('Either restore them or drop them from "files"; the bundle cannot be trusted to be complete.');
  process.exit(1);
}
// package.json is not in "files" because npm always ships it. The bundle needs it: the
// formula reads `bin` from it to decide what to link.
writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// Production dependencies only, and --ignore-scripts because the only prod dependency with
// a script is express's transitive tree and a lifecycle failure here would be indistinguishable
// from a real packaging problem in CI logs.
const npm = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
  { cwd: stage, encoding: 'utf8', timeout: 900_000 });
if (npm.status !== 0) {
  console.error(`npm install --omit=dev failed:\n${npm.stdout}\n${npm.stderr}`);
  process.exit(1);
}
if (!existsSync(join(stage, 'node_modules'))) {
  console.error('npm install produced no node_modules; the bundle would not run offline');
  process.exit(1);
}

const tgz = join(outDir, `mercury-${pkg.version}-bundle.tar.gz`);
const tar = spawnSync('tar', ['-czf', tgz, '-C', outDir, `mercury-${pkg.version}`],
  { encoding: 'utf8', timeout: 600_000 });
if (tar.status !== 0) {
  console.error(`tar failed:\n${tar.stdout}\n${tar.stderr}`);
  process.exit(1);
}

const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
// One line, machine-readable: CI feeds this straight into the Homebrew formula bump.
console.log(JSON.stringify({ tarball: tgz, version: pkg.version, sha256 }));
