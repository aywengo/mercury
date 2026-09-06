# Distribution

How Mercury reaches an operator. Three channels, one release train.

Status header: npm, GitHub Release and Homebrew are all implemented in `release.yml`; the `mercury-ai` formula is generated and pushed to `main` by the release job. See the guard in `test/releaseHygiene.test.ts` — this line must agree with what `release.yml` actually builds.

## Channels

| Channel | Command | Ships | State |
| --- | --- | --- | --- |
| npm | `npm install -g @aywengo/mercury@<tag>` | host + `mercuryctl` | implemented, blocked on `NPM_TOKEN` |
| GitHub Release | download asset, or `git clone` | host + `mercuryctl` | implemented |
| Git checkout | `git clone` + `npm ci` | host + `mercuryctl` | implemented (see #266) |
| Homebrew | `brew tap aywengo/mercury https://github.com/aywengo/mercury` then `brew install mercury-ai` | host + `mercuryctl` | wired into the release job |

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

The formula lives in **this repository** under `Formula/mercury-ai.rb`, and the repository is
tapped directly by URL:

```
brew tap aywengo/mercury https://github.com/aywengo/mercury
brew install mercury-ai
```

Verified against real Homebrew: `brew tap <name> <URL>` accepts an arbitrary repository and
Homebrew discovers `Formula/` at its root, and `brew info` then resolves the formula. The tap
clone costs 20 MB.

The alternative was the existing `aywengo/homebrew-tap` (which carries `ksr.rb` and
`ksr-cli.rb`) for the shorter `brew tap aywengo/tap`. It was rejected because the release job
would need a credential for a second repository, and because the formula would then be
maintained somewhere other than the thing it describes. Hosting it here means the release job
updates it with the `contents:write` token it already has -- `main` is not branch-protected --
so no new secret is required and the version cannot drift from the artifact.

The trade-off is that the tap command needs the explicit URL. That is documented above and
guarded by `test/releaseHygiene.test.ts`.

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
The formula is **generated**, not hand-maintained: `scripts/update-formula.mjs` writes it from
the version and the digest of the artifact that was just built. Two reasons:

- A committed formula would 404 for anyone who ran `brew install` before the release existed, so
  the release job creates it only after `gh release create` has uploaded the asset.
- A `tar.gz` is not byte-reproducible across implementations -- CI runs GNU tar, macOS ships
  bsdtar, and bsdtar rejects `--sort` outright -- so a digest computed on one host is not the
  digest the other produces. Deriving it at release time makes the pin correct by construction
  rather than a value someone must remember to refresh.

The formula must never be updated by hand to a version whose bundle is not already attached
to a published release. Ordering in the workflow enforces the related hazard: the bundle is
built before the release exists, and `npm publish` runs before `gh release create`, so a
failed publish cannot leave a public release advertising an uninstallable version.

## Release procedure

1. Prepare the release (versions, notes, changelog) — `docs/releasing.md`.
2. Tag `host-v<version>`. `release.yml`:
   - refuses if neither an npm credential nor a runner OIDC id-token is available, **before**
     creating the GitHub Release (#265);
   - builds, packs the npm tarball, builds the Homebrew bundle;
   - **stages** the package on npm under a dist-tag derived from the version (`rc`, `beta`,
     `latest`), rather than publishing it directly;
   - creates the GitHub Release with the npm tarball **and** the bundle attached, and appends a
     notice to the release body while the npm package still awaits approval;
   - generates `Formula/mercury-ai.rb` from the bundle digest and pushes it to `main`.
3. Approve the staged package on npmjs.com (**Published packages -> Staged packages**). This is
   the one step a machine cannot do: staged publishing exists precisely to defer
   proof-of-presence to a human. Nothing else waits on it -- the release assets and the
   Homebrew formula are already live.
4. Verify: npm dist-tag, GitHub Release assets, `brew install` from the tap.

Set the repository variable `NPM_DIRECT_PUBLISH` to `true` to skip staging once an OIDC
configuration with direct publishing is in place.

`fleet-v<version>` publishes Fleet to npm only; Fleet has no Homebrew formula.

## Verification status

What has actually been executed, and what has not. The distinction matters because the
release path had already been shown to contain a step that had never run.

Verified end to end, in order, on a fresh clone of `main`:

1. `npm ci` built `dist/` via `prepare`.
2. `scripts/build-bundle.mjs` produced `mercury-0.1.0-rc1-bundle.tar.gz` and reported its sha256.
3. `scripts/update-formula.mjs` generated `Formula/mercury-ai.rb` pinning that digest; `ruby -c` accepted it.
4. The artifact was served over real HTTP and `brew install mercury-ai` fetched it. Homebrew
   verifies the pinned digest on download, so a successful install is evidence the digest the
   generator wrote matches the bytes the bundler produced -- the two ends of the chain were
   never compared by hand.
5. Installed `mercury --version` -> `mercury-host 0.1.0-rc1`, `mercuryctl --version` ->
   `mercuryctl 0.1.0-rc1`, and `mercury --help` listed the command groups.
6. `brew audit --strict` on the generated formula reported no findings.

Exercised for real by pushing `host-v0.1.0-rc1`. This was the first time the release job had
ever run, and it got as far as the publish before npm refused it:

- `npm ci` installed and compiled on `ubuntu-latest`; the tag regex, the notes lookup and the
  manifest comparison all accepted a real tag.
- The provenance statement was signed and recorded in the sigstore transparency log.
- `npm publish` ran with the correct dist-tag (`rc`) and was rejected with
  `E404 PUT /@aywengo%2fmercury`. Two different tokens were tried; `npm whoami` succeeded on
  both, so both were valid and simply not permitted to publish. npm is removing direct publish
  from 2FA-bypassing granular tokens (github.blog changelog, 2026-07-31).
- **The ordering guard held.** With the publish failing, no GitHub Release was created and no
  formula was pushed. The half-release that #265 and #271 were written to prevent did not
  occur, observed rather than asserted.

What the credential can and cannot do, measured against the live registry:

- `npm whoami` succeeds, so the token is valid.
- Direct publish is refused (`E404 PUT`). npm is removing direct publish from 2FA-bypassing
  granular tokens, and its own docs list only two ways to publish a scoped package directly:
  account 2FA, or such a token.
- **`npm stage list` succeeds**, so the staging API accepts this credential. Staged publishing
  deliberately needs no 2FA to submit, which is what makes CI able to reach the registry at all
  under the current policy -- and it is the difference between the job producing Homebrew
  artifacts and aborting before it gets there.

Still not observed, and the reason the channels are not yet installable:

- **A successful `npm publish`.** Blocked on npm authorization, not on this repository. The
  durable answer is OIDC trusted publishing, which `release.yml` now falls back to
  automatically; enabling it needs a one-time interactive configuration on npmjs.com, and npm
  will not accept that change from a token -- it is exactly the class of action the 2026-07-31
  change reserves for an interactive 2FA challenge.
- **The GitHub Releases download URL.** The verification above served the artifact over local
  HTTP because nothing is published. The URL shape is asserted by `test/formula.test.ts` against
  the asset name `scripts/build-bundle.mjs` produces, which catches a rename but not, say, an
  asset that failed to upload.
- **The formula commit back to `main`.** `test/releaseWorkflow.test.ts` asserts the step exists,
  runs after `gh release create`, and pushes `HEAD:main`, using a stubbed `git`. `main` is not
  branch-protected, so the push should succeed; it has not been observed to.

One consequence of OIDC worth stating before it surprises anyone: npm stages trusted publishes
by default and makes direct publishing opt-in per configuration. A tag push may therefore leave
the version sitting in the npm staging queue until a maintainer approves it on npmjs.com. That
is a safety property rather than a defect -- a compromised workflow cannot push straight to the
registry -- but it does mean "tag pushed" is not yet "installable" until direct publishing is
turned on for the configuration.



## Decisions

- **CI stages the npm package instead of publishing it directly.** Decided from the live registry rather than from preference: direct publish is refused for the credential class npm leaves standing, staging is accepted, and npm recommends staging for CI anyway. The cost is one human approval per release, which the release body discloses so the notes cannot overstate availability.
- **npm authentication prefers OIDC over a long-lived token.** Decided after two valid tokens were refused direct publish. The token path is kept because it still works for accounts whose tokens retain publish, but it is no longer a requirement, and the OIDC path logs verbosely because npm's OIDC helper reports every failure at `verbose` and never throws.
- **The bundle vendors its production `node_modules`.** Decided by implementation and
  measured: the whole production tree is `express` plus 67 transitive packages, 3.9 MB,
  1.2 MB compressed. Vendoring makes `brew install` need no network and no build, which is
  what makes the offline verification above possible. The alternative -- the formula running
  `npm install --omit=dev` -- would make every install depend on the registry and on
  Homebrew's sandbox network policy, to save about one megabyte.
- **The formula lives in this repository, not a separate tap.** See *Tap* above.
- **The formula is generated, not committed.** See *Version and sha256 updates* above.
