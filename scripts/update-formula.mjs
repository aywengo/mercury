// Write (or update) the Homebrew formula for the host bundle.
//
// The formula lives in THIS repository and users tap the repository directly:
//
//     brew tap aywengo/mercury https://github.com/aywengo/mercury
//     brew install mercury-ai
//
// Verified against real Homebrew: `brew tap <name> <URL>` accepts an arbitrary repository and
// Homebrew discovers Formula/ at its root. Keeping the formula here rather than in a separate tap
// repository means the release job can update it with the contents:write token it already has, so
// no cross-repository credential is needed and the version cannot drift from the artifact.
//
// The sha256 is written from the artifact that was just built rather than committed in advance. A
// tar.gz is not byte-reproducible across implementations -- CI runs GNU tar, macOS ships bsdtar,
// and bsdtar rejects --sort outright -- so a digest computed on one host is not the digest the
// other produces. Deriving it at release time makes the pin correct by construction.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function arg(name, required = true) {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (required && !value) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return value;
}

const version = arg('--version');
const sha256 = arg('--sha256');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const formulaPath = arg('--formula', false) ?? join(ROOT, 'Formula', 'mercury-ai.rb');

// Fail before writing anything. A formula with a malformed digest installs nothing useful, and
// Homebrew's checksum error at the point of use is far harder to trace back than one here.
if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
  console.error(`refusing to write formula: ${JSON.stringify(version)} is not a usable version string`);
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/.test(sha256)) {
  console.error(`refusing to write formula: sha256 must be 64 lowercase hex characters, got ${JSON.stringify(sha256)}`);
  process.exit(1);
}

// Homebrew derives the class name from the filename: mercury-ai.rb -> MercuryAi. Getting this wrong
// is a load error that breaks every formula in the tap, not just this one.
const className = basename(formulaPath, '.rb').split(/[-_]/)
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

const url = `https://github.com/aywengo/mercury/releases/download/host-v${version}/mercury-${version}-bundle.tar.gz`;

const body = [
  `class ${className} < Formula`,
  '  desc "Durable orchestration layer for long-running coding-agent runs"',
  '  homepage "https://github.com/aywengo/mercury"',
  `  url "${url}"`,
  `  sha256 "${sha256}"`,
  '  license "MIT"',
  '',
  '  depends_on "node"',
  '',
  '  def install',
  '    # The bundle is prebuilt and vendors its production dependencies, so there is no build',
  '    # step and no network access at install time.',
  '    libexec.install Dir["*"]',
  '    pkg = JSON.parse(File.read(libexec/"package.json"))',
  '    pkg.fetch("bin").each do |name, rel|',
  '      target = libexec/rel',
  '      # The compiled entry points are mode 644 in the bundle and write_env_script execs its',
  '      # argument directly, so they must be made executable or every command exits 126.',
  '      target.chmod 0755',
  '      (bin/name).write_env_script target, PATH: "#{formula_opt_bin("node")}:$PATH"',
  '    end',
  '  end',
  '',
  '  test do',
  '    assert_match version.to_s, shell_output("#{bin}/mercury --version")',
  '    assert_match version.to_s, shell_output("#{bin}/mercuryctl --version")',
  '  end',
  'end',
  '',
].join('\n');

mkdirSync(dirname(formulaPath), { recursive: true });
writeFileSync(formulaPath, body);

// Only assert what the local toolchain can check. `ruby -c` exists on macOS and on CI images; when
// it does not, the structural checks in test/formula.test.ts still run.
const syntax = spawnSync('ruby', ['-c', formulaPath], { encoding: 'utf8', timeout: 120_000 });
if (syntax.status === 0) {
  console.log(JSON.stringify({ formula: formulaPath, version, sha256, url, rubySyntax: 'ok' }));
} else if (syntax.error && syntax.error.code === 'ENOENT') {
  console.log(JSON.stringify({ formula: formulaPath, version, sha256, url, rubySyntax: 'skipped (no ruby)' }));
} else {
  console.error(`generated formula does not parse:\n${syntax.stdout}\n${syntax.stderr}`);
  process.exit(1);
}
