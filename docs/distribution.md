# Distribution

How Mercury reaches an operator. Three channels, one release train.

Status header: npm and GitHub Release implemented; the Homebrew bundle is built and attached by `release.yml`, and the `mercury-ai` formula is validated but **not yet published to the tap**. See the guard in `test/releaseHygiene.test.ts` — this line must agree with what `release.yml` actually builds.

## Channels

| Channel | Command | Ships | State |
| --- | --- | --- | --- |
| npm | `npm install -g @aywengo/mercury@<tag>` | host + `mercuryctl` | implemented, blocked on `NPM_TOKEN` |
| GitHub Release | download asset, or `git clone` | host + `mercuryctl` | implemented |
| Git checkout | `git clone` + `npm ci` | host + `mercuryctl` | implemented (see #266) |
| Homebrew | `brew tap aywengo/tap && brew install mercury-ai` | host + `mercuryctl` | bundle built by CI; formula pending in the tap |

Host and CLI are **one artifact**. There is no CLI-only channel and no separate CLI
version: `package.json` `bin` carries both `mercury` and `mercuryctl`, so any install
that produces one produces the other. Earlier drafts of the release docs described them
as independent streams; that was wrong and is now guarded by `test/releaseHygiene.test.ts`.

## Artifact shapes

### npm tarball

Produced by `npm publish`, which runs `prepare` to compile `dist/`. Contains sources and
`dist/` but **not** `node_modules`, so installing it resolves `express` from the registry.

### Git checkout

`git clone` then `npm ci`. `prepare` compiles `dist/` during install. Needs devDependencies
(`typescript`) present, so `npm ci` must come first. `npm pack` on a bare checkout without
devDependencies fails with exit 127 for the same reason; release CI always runs `npm ci`
first, so it never hits this.

### Homebrew bundle

A self-contained, prebuilt tree that vendors its production dependencies. No build step and
no network at install time.

Contents: `dist/`, `src/`, `client/`, `ui/`, `deploy/`, `*-agents/`, `.agents/`, `LICENSE`,
`README.md`, `QUICKSTART.md`, `package.json`, and a production-only `node_modules/`.

Measured: **5.8 MB staged, 1.2 MB as `.tar.gz`**, 795 files / 3.9 MB installed, 3 s install.
The footprint is small because the production dependency tree is a single package
(`express`, 68 packages transitively, 3.9 MB).

Name: `mercury-<version>-bundle.tar.gz`, attached to the `host-v<version>` GitHub Release.
Built by `scripts/build-bundle.mjs`, whose staged file list is **derived from
`package.json` `files`** rather than repeated: two hand-maintained lists is how the npm
tarball and the bundle would drift, and the drift would only appear after install. The
script refuses outright if `files` names a path that does not exist, rather than staging
what it happened to find.

## Homebrew

### Tap

Use the existing **`aywengo/homebrew-tap`**, which already carries `ksr.rb` and
`ksr-cli.rb`. No new repository is needed.

### Name collision — `mercury` is taken

`brew install mercury` does **not** install Mercury. Homebrew core owns `mercury`:
`mercury: stable 22.01.9 (bottled)`, the [Mercury language compiler](https://mercurylang.org/).
This was discovered by running it: it installed 6,676 files / 984.7 MB of an unrelated
compiler before the version string gave it away.

Free at time of writing: `mercuryctl`, `mercury-host`, `mercury-orchestrator`, `mercury-run`.

The formula is therefore named **`mercury-ai`** (decided in #268; confirmed free in
homebrew-core). The binaries are unchanged: the formula installs whatever `package.json`
`bin` declares, so it cannot drift from the product, and renaming the host binary would be
a breaking change across every doc, config example and deploy unit.

The collision is deeper than the formula name and is **accepted, not solved**: our host
binary is itself called `mercury`, so an operator who also has the language compiler
installed hits a `bin/mercury` link conflict regardless of the formula name. Homebrew
surfaces that at install time and lets the operator choose which to unlink. That is
acceptable because it is visible and recoverable at the moment it matters rather than
silent. If it bites in practice the fix is to rename the long-running host (for example
`mercuryd`), which should be its own issue.

### Formula

Follows the structure of the existing `ksr.rb` (per-release `url` + `sha256`, `test` block)
with the parts that do not transfer to a Node application replaced. `ksr.rb` installs a
single prebuilt native binary; Mercury is a Node application, so it installs a tree.

```ruby
class MercuryAi < Formula
  desc "Durable orchestration layer for long-running coding-agent runs"
  homepage "https://github.com/aywengo/mercury"
  url "https://github.com/aywengo/mercury/releases/download/host-v<version>/mercury-<version>-bundle.tar.gz"
  sha256 "<sha256 of the bundle>"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    pkg = JSON.parse(File.read(libexec/"package.json"))
    pkg.fetch("bin").each do |name, rel|
      target = libexec/rel
      target.chmod 0755
      (bin/name).write_env_script target, PATH: "#{formula_opt_bin("node")}:$PATH"
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mercury --version")
    assert_match version.to_s, shell_output("#{bin}/mercuryctl --version")
  end
end
```

Iterating `package.json` `bin` rather than hard-coding the list means a new binary cannot
silently miss distribution.

Two details that were only visible by actually installing it:

- **`target.chmod 0755` is required.** The compiled entry points are mode 644 in the
  bundle, and `write_env_script` execs its argument directly. Without the `chmod` every
  installed command exits **126**. This was the observed failure, not a hypothetical.
- **`write_env_script` with `formula_opt_bin("node")`** rather than a symlink: the entry
  points carry a `#!/usr/bin/env node` shebang, so `node` must be on `PATH`, and a symlink
  into `libexec` would neither set `PATH` nor be executable.

Validated against real Homebrew under the chosen name: `brew install mercury-ai` produced
795 files / 3.9 MB in about a second, `mercury --version` printed `mercury-host 0.1.0-rc1`
and `mercuryctl --version` printed `mercuryctl 0.1.0-rc1`, and `brew audit --strict`
reported no findings. The audit drove three earlier corrections (drop the redundant
`version`, put `url` before `version`, use `formula_opt_bin` rather than `Formula[...].opt_bin`).

### Version and sha256 updates

`release.yml` builds the bundle, prints `bundle sha256=<digest>`, and attaches the
artifact; the digest printed is the digest the formula must pin, and
`test/bundle.test.ts` asserts the script reports the sha256 of the bytes it actually wrote.
The remaining step is publishing `Formula/mercury-ai.rb` to `aywengo/homebrew-tap`.

The formula must never be updated by hand to a version whose bundle is not already attached
to a published release. Ordering in the workflow enforces the related hazard: the bundle is
built before the release exists, and `npm publish` runs before `gh release create`, so a
failed publish cannot leave a public release advertising an uninstallable version.

## Release procedure

1. Prepare the release (versions, notes, changelog) — `docs/releasing.md`.
2. Tag `host-v<version>`. `release.yml`:
   - refuses if `NODE_AUTH_TOKEN` is absent, **before** creating the GitHub Release (#265);
   - builds, packs the npm tarball, builds the Homebrew bundle;
   - creates the GitHub Release with the npm tarball **and** the bundle attached;
   - publishes to npm under a dist-tag derived from the version (`rc`, `beta`, `latest`).
3. Update `aywengo/homebrew-tap` with the new version and bundle `sha256`.
4. Verify: npm dist-tag, GitHub Release assets, `brew install` from the tap.

`fleet-v<version>` publishes Fleet to npm only; Fleet has no Homebrew formula.

## Decisions still open

- **Whether the bundle should vendor `node_modules`** or let the formula run
  `npm install --omit=dev`. Vendoring makes installs offline-capable and faster, at the
  cost of a larger artifact; the artifact is 1.2 MB, so the cost is currently trivial.
