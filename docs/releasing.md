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

6. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates the GitHub Release from
   the notes file for that tag and runs `npm publish --access public --provenance`. It handles `host`
   and `fleet` tags only; any other tag is refused.

The `NPM_TOKEN` repository secret must exist on `aywengo/mercury` before the
first tag. npm publish fails closed without it. This is intended.

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
