# Releasing Mercury

Host and Fleet are released as **independent SemVer streams**. Bump only the
product that changed. Do not use a bare `v0.1.0` tag.

The CLI has **no tag and no version of its own**. `mercuryctl` ships inside
`@aywengo/mercury`, so it is released whenever the host is, at the host version,
and its notes belong in the host release notes. There used to be a `cli-vX.Y.Z`
tag; it published a GitHub Release and no artifact, so it announced a version
nobody could install. Nothing was ever tagged with it and it has been removed.

| Product | Version file | Tag | npm | Notes |
| --- | --- | --- | --- | --- |
| Host | root `package.json` + `src/version.ts` (`HOST_VERSION`) | `host-vX.Y.Z` | `@aywengo/mercury` | `docs/releases/host/X.Y.Z.md` |
| Fleet | `fleet/package.json` + `fleet/version.ts` (`FLEET_VERSION`) | `fleet-vX.Y.Z` | `@aywengo/mercury-fleet` | `docs/releases/fleet/X.Y.Z.md` |

`HOST_VERSION` / `FLEET_VERSION` must equal the matching `package.json`
`"version"`. Contract tests fail if they drift.

## Cut a release

1. On a branch from `main`, bump **only** the changed product:
   - host: root `package.json` and `HOST_VERSION` in `src/version.ts`;
   - Fleet: `fleet/package.json` and `FLEET_VERSION` in `fleet/version.ts`;
   - CLI: nothing to bump and no tag to push. It ships inside `@aywengo/mercury`, so a CLI change
     goes out with the next host release and is described in that release's notes.
2. Move that product's `## [Unreleased]` changelog entries under
   `## [X.Y.Z] - YYYY-MM-DD`.
3. Add `docs/releases/<product>/X.Y.Z.md` (GitHub Release body).
4. Open a PR, merge to `main`.
5. On the merge commit:

   ```bash
   git tag -a host-vX.Y.Z -m "Mercury host vX.Y.Z"
   git push origin host-vX.Y.Z
   ```

   Same commit may also carry `fleet-vX.Y.Z` if both products ship together.

5a. **Rehearse before you tag.** A tag is a published artifact, so a mistake in the release job costs a
   burned version number. Run the workflow by hand instead:

   ```bash
   gh workflow run release.yml --repo aywengo/mercury --ref main
   ```

   It does everything a real release does -- tag parsing, the manifest and notes checks, install, the
   Homebrew bundle, the OIDC exchange, and the real `npm publish` pack -- then stops short of the three
   things that touch the outside world: `npm publish`, `gh release create`, and the formula push. It
   takes no input and cannot publish; the mode is derived from the event name, so a tag push is never a
   rehearsal and a rehearsal is never a release.

   The OIDC part is the reason to run it before tagging rather than after. The log prints the claims npm
   matches the run against, and then performs the exchange npm itself performs -- the POST to
   `/-/npm/v1/oidc/token/exchange/package/<name>` that turns the id token into a short-lived publish
   credential -- and reports `ACCEPTED`, `REFUSED` or `INCONCLUSIVE`. A refusal fails the rehearsal,
   because a real release would die on the same call. This matters because `npm publish --dry-run` does
   not authenticate: before the exchange was probed, a green rehearsal said nothing whatever about
   whether npm trusts the workflow, which is the one thing a release candidate most often gets wrong.
   npm reports a trusted-publishing mismatch as an opaque registry 404 with no reason, so the exchange
   result and the claims are the only way to see the cause without burning a version number.

6. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates the GitHub Release from
   the notes file for that tag and publishes to npm with provenance. It handles `host` and `fleet` tags
   only; any other tag is refused.

## Publishing credential

**There is none, and that is the intended steady state.** The package publishes through npm's trusted
publishing: the workflow exchanges the GitHub Actions OIDC id-token for a short-lived credential, so no
long-lived secret exists in the repository. `NPM_TOKEN` was deleted once trusted publishing was
configured. The workflow still prefers `NPM_TOKEN` if the secret is ever re-added, and refuses the tag
before creating any release if neither credential is available.

Two things to know about the npm-side configuration, both on the package's *Trusted Publisher* settings
page (which only exists once the package has been published at least once):

- It matches **owner, repository and workflow filename** -- `aywengo`, `mercury`, `release.yml`. Not a
  branch, so tag-push releases are covered.
- **Direct publishing is opt-in.** `npm stage publish` is always allowed; publishing straight to the
  registry must be enabled per configuration. The repository variable `NPM_DIRECT_PUBLISH=true` tells
  the workflow to publish directly, so it must be matched by that setting or the submit is rejected.
  Unset the variable to stage instead, which defers to a maintainer approving it on npmjs.com.

## Prereleases

A tag may carry a SemVer prerelease: `host-v0.1.0-rc1`, `fleet-v0.1.0-rc1`. The version in the tag
must still equal the matching `package.json` exactly, so a prerelease is cut by bumping the manifest
to `0.1.0-rc1` first, exactly as for a stable release.

**A prerelease is published under its own npm dist-tag, never `latest`.** npm applies `latest` to any
version published without `--tag` -- `npm config get tag` prints `latest` -- so publishing an RC the
naive way makes `npm install @aywengo/mercury` resolve to the release candidate for everyone. The
workflow derives the tag from the version: `0.1.0-rc1` and `0.1.0-rc.2` go to **`rc`**,
`1.2.0-beta.3` goes to **`beta`**, and a stable version still goes to **`latest`**.

```bash
npm install -g @aywengo/mercury@rc     # the newest RC
npm install -g @aywengo/mercury        # stable; untouched by an RC publish
```

The first identifier is what becomes the dist-tag, with trailing digits and any sub-parts removed. A
prerelease with no alphabetic identifier (`1.0.0-1`) falls back to `next` rather than publishing an
empty tag.

To promote an RC, cut a new release at the plain version: bump the manifest to `0.1.0`, move the
changelog entry, add `docs/releases/host/0.1.0.md`, tag `host-v0.1.0`. The RC stays on the `rc`
dist-tag and ages out on its own.

## The CLI

`mercuryctl` ships inside `@aywengo/mercury`. It has no version of its own, no tag,
and no notes file of its own: a CLI change is described in the host release notes
for the version that carries it. `package.json` `bin` entry `mercuryctl` is the
whole of its release surface.

There used to be a `cli-vX.Y.Z` tag. It created a GitHub Release and published
nothing, because `npm publish` runs for `host` and `fleet` only. So it announced a
version to readers of the releases page that nobody could install -- and it could
only be cut after the host release artifacts for that version already existed,
which is most of the work of a host release. It was removed before any `cli-*` tag
was ever pushed, so nothing is stranded.

To verify the packaged client before tagging a host release:

```bash
npm pack && rm -rf /tmp/cli-verify && mkdir -p /tmp/cli-verify/consumer/node_modules/@aywengo/mercury
tar -xzf aywengo-mercury-*.tgz -C /tmp/cli-verify/consumer/node_modules/@aywengo/mercury --strip-components=1
node /tmp/cli-verify/consumer/node_modules/@aywengo/mercury/dist/client/bin.js --version
```

Two things this snippet had wrong before it was run: `tar -C` does not create its
target, so `mkdir -p` must make the full `@aywengo/mercury` path rather than just
`@aywengo`; and the path being executed named `@aywengo/package`, which nothing
ever creates. As written it exited 1 on the `tar` line without verifying anything.

The `node_modules` path is deliberate: Node refuses to strip types under
`node_modules`, which is how the first published artifact shipped unrunnable while
every source-tree test stayed green.

This verifies the client only. The server CLI imports `express`, so a bare
extraction cannot run it -- install dependencies, or verify it from a real
`npm install -g` of the packed tarball.

## What this document is not

It does not authorize tagging or publishing from a hygiene or docs PR. Tags
are a separate, explicit step after merge.
