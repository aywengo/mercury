# Distribution

How Mercury reaches an operator. Three channels, one release train.

Status header: npm, GitHub Release and Homebrew are all implemented in `release.yml`; the `mercury-ai` formula is generated and pushed to `main` by the release job. See the guard in `test/releaseHygiene.test.ts` — this line must agree with what `release.yml` actually builds.

## Channels

| Channel | Command | Ships | State |
| --- | --- | --- | --- |
| npm | `npm install -g @aywengo/mercury@<tag>` | host + `mercuryctl` | live; `0.1.0` on `latest`, `0.1.0-rc2` on `rc` |
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
## First release only

The package does not exist on npm yet, and creating the first version is an interactive action.

**The precondition, stated up front because the error messages do not:** npm requires **one of**

- two-factor authentication enabled on the account, or
- a granular access token with **bypass 2FA** enabled.

Without either, publishing a scoped package fails. Interactively the message is explicit:

```
npm error 403 Forbidden - PUT https://registry.npmjs.org/@aywengo%2fmercury - Two-factor
authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

From CI the same root cause surfaces with far less useful codes: `E404` on `npm publish` and
`E401` on `npm stage publish`, while read calls with the same token succeed. That asymmetry --
reads fine, both writes refused -- is the signature of this missing precondition rather than a
bad token or a wrong scope.

Prefer account 2FA. A bypass-2FA token may work today, but npm is removing direct publish from
those tokens (github.blog changelog, 2026-07-31, targeting January 2027), so it is a dead end.

1. Enable 2FA on npmjs.com under **Account Settings -> Two-Factor Authentication**.
2. From a clean checkout of the tag: `npm publish --access public --tag <dist-tag>`, where the tag
   is the one `release.yml` would derive from the version -- **not** a literal `rc`. The rule the
   workflow implements is: a stable version goes to `latest`; a prerelease goes to its first
   identifier with everything from the first digit onward removed, so `0.1.0-rc1` and `0.1.0-rc.2`
   give `rc`, and `1.2.0-beta.3` gives `beta`.
   An identifier that starts with a digit has no leading prefix left to use, so `1.0.0-1` falls back
   to `next`. Match the rule, or the manual publish and every later automated one disagree. The `--tag` matters because npm's default dist-tag is `latest` for *any*
   version, prerelease included, so publishing an `-rc` without it makes
   `npm install @aywengo/mercury` resolve to the release candidate. Passing `--tag rc` for a stable
   first version has the mirror defect: the package lands under a tag no default install reads.
   Note that npm initialises `latest` to the first version ever published regardless of `--tag`, and
   refuses to delete that tag afterwards, so a prerelease published first will also be `latest`
   until a stable version replaces it.
3. Configure trusted publishing on the package's npmjs.com settings page -- owner `aywengo`,
   repository `mercury`, workflow filename `release.yml` -- for each package you publish. The page
   only exists once the package does, so **each package needs its own interactive first publish
   before it can be configured**; `@aywengo/mercury-fleet` is not an exception, and there is no way
   to configure it in advance. Note that npm stages trusted publishes by default and makes direct
   publishing opt-in per configuration: unless you additionally select direct
   publishing, a publisher created after 2026-09-03 permits `npm stage publish` and nothing else. The workflow chooses direct
   publishing when the repository variable `NPM_DIRECT_PUBLISH` is set, so the variable and the
   publisher setting must agree -- if they do not, the release fails.
4. From then on a tag push needs no credential at all: `release.yml` uses the runner's OIDC
   id-token, and `NPM_TOKEN` can be deleted.

Everything after the first release is the procedure below.


1. Prepare the release (versions, notes, changelog) — `docs/releasing.md`.
2. Tag `host-v<version>`. `release.yml`:
   - refuses if neither an npm credential nor a runner OIDC id-token is available, **before**
     creating the GitHub Release (#265);
   - builds, packs the npm tarball, builds the Homebrew bundle;
   - **stages** the package on npm under a dist-tag derived from the version (`rc`, `beta`,
     `latest`), rather than publishing it directly;
   - creates the GitHub Release with the npm tarball **and** the bundle attached, and appends a
     notice to the release body describing the npm state accurately -- staged-and-awaiting-approval,
     or not-available-at-all;
   - generates `Formula/mercury-ai.rb` from the bundle digest and pushes it to `main`;
   - fails the job **last** if the npm submission failed, so the gap is visible without taking the
     Homebrew channel down with it (#277).
3. Approve the staged package on npmjs.com (**Published packages -> Staged packages**). This is
   the one step a machine cannot do: staged publishing exists precisely to defer
   proof-of-presence to a human. Nothing else waits on it -- the release assets and the
   Homebrew formula are already live.
4. Verify: npm dist-tag, GitHub Release assets, `brew install` from the tap.

Set the repository variable `NPM_DIRECT_PUBLISH` to `true` only after confirming on npmjs.com that
this package's Trusted Publisher permits direct `npm publish`. A publisher created after 2026-09-03
does not by default permit direct `npm publish` -- it permits `npm stage publish` only -- so with that
configuration the variable does not skip an approval, it turns a would-be staged release into a failed
one.

`fleet-v<version>` publishes Fleet to npm only; Fleet has no Homebrew formula.

## Verification status

What has actually been executed, and what has not. The distinction matters because the
release path had already been shown to contain a step that had never run.

Verified end to end against real infrastructure, not a local stand-in. Pushing `host-v0.1.0-rc1`
ran `release.yml` for real, and the release job produced:

1. A GitHub Release `Mercury host v0.1.0-rc1` with `mercury-0.1.0-rc1-bundle.tar.gz` attached
   (1.16 MB).
2. A commit by `github-actions[bot]` adding `Formula/mercury-ai.rb` to `main`.
3. A release body that states the npm package is unavailable, because the npm step did fail.

Then, from a real machine with a real Homebrew:

4. `brew tap aywengo/mercury https://github.com/aywengo/mercury` cloned the tap and found the
   formula. Newer Homebrew refuses an untrusted tap, so `brew trust aywengo/mercury` is required
   before install; the error message names the command.
5. `brew install mercury-ai` downloaded the asset from the real Releases URL. Homebrew verifies
   the pinned digest on download, so a successful install proves the formula's sha256 matches the
   bytes the bundler produced and GitHub served. Independently confirmed: the downloaded artifact
   hashes to `0d2c888161d3b17f087414e20ece64e9bc989ee296c1c2e3e774a56ba8b3739f`, identical to the
   value in the generated formula.
6. `mercury --version` -> `mercury-host 0.1.0-rc1`; `mercuryctl --version` -> `mercuryctl
   0.1.0-rc1`; `mercury --help` listed the command groups. 793 files installed.
7. `brew audit --strict` on the generated formula reported no findings.

One consequence of the formula worth knowing before it surprises a user: it depends on `node`, so
`brew install mercury-ai` installs or upgrades **Homebrew's** `node`. On the machine used for the
test above that moved the shell's active `node` from 24.1.0 to 26.8.1, because that machine resolves
`node` through Homebrew. It will not move the active version for someone using nvm, asdf, or a PATH
that puts another Node first -- what changes is the Homebrew-managed copy, and whether that is the
one they run depends on their setup. This is ordinary Homebrew behaviour for a `depends_on "node"`
formula, not a defect in this one, but it is not obvious from the install command and a user who
pins a Node major version should check which Node they are actually running.

Still not observed:

- **A successful npm submission from the release workflow.** `0.1.0-rc1` is on the registry,
  published interactively, and the channel works. What has not yet run is the submit that
  `release.yml` performs under an OIDC id-token: the workflow had never reached that call until the
  credential was replaced, and every earlier attempt failed on authentication. The rehearsal covers
  everything up to it and prints the three claims npm matches, but a rehearsal deliberately does not
  submit, so the last call is unexercised until the next tag is pushed.
- **Whether the trusted publisher permits direct publishing.** npm always allows
  `npm stage publish`; direct `npm publish` is opt-in per configuration, and the repository variable
  `NPM_DIRECT_PUBLISH` makes the workflow ask for direct publishing, so the two must agree. The
  setting cannot be read without publish rights, so a mismatch surfaces only on a real release --
  which the job now names as a candidate cause rather than leaving as a bare 404.
- **Whether npm trusts this workflow at all.** The rehearsal attempts the same token exchange a publish
  does, and also attempts it against an unrelated package as a control. Both are refused with the
  identical message, `OIDC token exchange error - unauthorized`, on both candidate audiences. An
  unrelated package with no trusted publisher of any kind is treated exactly the same, so the message
  is what the registry says to a token it will not exchange from anywhere; it is not evidence about
  this repository's configuration. An earlier version of this document claimed the rehearsal
  established trust from an `ACCEPTED` or `REFUSED` line. It does not, and the claim was made from one
  observation before the control existed.
- **Whether the credential npm issues may be spent on a direct publish.** Unreachable from here, and
  for a second reason: in the npm CLI's own implementation (`lib/commands/stage/publish.js` in
  `npm/cli`, not a file in this repository) staging is `class StagePublish extends Publish`, so
  staging and direct publishing go through the identical exchange call. The allowed-actions setting
  therefore cannot be probed by choosing a verb -- both verbs ask the same question the same way.

## Decisions

- **An npm failure does not block the Homebrew release.** Decided in response to #277, after the coupling stopped being hypothetical: a registry policy change made both npm write paths fail, and because the job aborted at that call the bundle and the formula were never built, so a channel that needs nothing from npm went down with it. The invariant the job protects is that the release body accurately describes what is installable, not that a release requires npm to have succeeded; the body now states the npm state explicitly and the job still goes red, at the end. Red means "npm needs attention", not "Mercury cannot be installed".
- **CI stages. Direct publishing is available by opt-in and is not used here.** Staging is the default
  because it is the only write path that is always permitted: npm's trusted-publishing settings make
  `npm stage publish` allowed unconditionally, while direct `npm publish` is a per-configuration choice.
  The date matters. npm's own documentation says a trusted publisher **created after 2026-09-03 is
  automatically set to allow `npm stage publish` only**, and that permitting direct publishing is a
  separate selection. This repository's publisher was created in that window, so `NPM_DIRECT_PUBLISH`
  was set on an assumption that npm would accept direct publishes. It was removed once the date rule
  was read, because with that configuration the variable does not skip an approval -- it fails the
  release. Stated as an invariant, without reference to what the variable currently holds:
  **`NPM_DIRECT_PUBLISH` may be set only when the package's Trusted Publisher explicitly permits direct
  publishing.** That permission cannot be read without publish rights, so it is confirmed on npmjs.com
  rather than inferred; inferring it is what put the variable there.
- **A release body states its npm state explicitly.** Staging costs one maintainer approval per release
  and the body says so, so the notes cannot overstate availability whichever verb was used.
- **npm authentication prefers OIDC over a long-lived token.** Decided after two valid tokens were refused direct publish. The token path is kept because it still works for accounts whose tokens retain publish, but it is no longer a requirement, and the OIDC path logs verbosely because npm's OIDC helper reports every failure at `verbose` and never throws.
- **The bundle vendors its production `node_modules`.** Decided by implementation and
  measured: the whole production tree is `express` plus 67 transitive packages, 3.9 MB,
  1.2 MB compressed. Vendoring makes `brew install` need no network and no build, which is
  what makes the offline verification above possible. The alternative -- the formula running
  `npm install --omit=dev` -- would make every install depend on the registry and on
  Homebrew's sandbox network policy, to save about one megabyte.
- **The formula lives in this repository, not a separate tap.** See *Tap* above.
- **The formula is generated, not committed.** See *Version and sha256 updates* above.
