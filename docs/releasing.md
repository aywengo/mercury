# Releasing Mercury

Host, Fleet, and the future `mercuryctl` CLI are **independent SemVer
streams**. Bump only the product that changed. Do not use a bare `v0.1.0` tag.

| Product | Version file | Tag | npm | Notes |
| --- | --- | --- | --- | --- |
| Host | root `package.json` + `src/version.ts` (`HOST_VERSION`) | `host-vX.Y.Z` | `@aywengo/mercury` | `docs/releases/host/X.Y.Z.md` |
| Fleet | `fleet/package.json` + `fleet/version.ts` (`FLEET_VERSION`) | `fleet-vX.Y.Z` | `@aywengo/mercury-fleet` | `docs/releases/fleet/X.Y.Z.md` |
| CLI | none yet | `cli-vX.Y.Z` reserved | none | reserved until `mercuryctl` exists |

`HOST_VERSION` / `FLEET_VERSION` must equal the matching `package.json`
`"version"`. Contract tests fail if they drift.

## Cut a release

1. On a branch from `main`, bump **only** the changed product:
   - host: root `package.json` and `HOST_VERSION` in `src/version.ts`;
   - Fleet: `fleet/package.json` and `FLEET_VERSION` in `fleet/version.ts`.
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

6. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates
   the GitHub Release and runs `npm publish --access public --provenance` for
   that product.

The `NPM_TOKEN` repository secret must exist on `aywengo/mercury` before the
first tag. npm publish fails closed without it. This is intended.

## Reserved: CLI

Do not add `docs/releases/cli/` or a CLI version file until `mercuryctl`
exists. A `cli-v*` tag fails the workflow until that notes file is present.

## What this document is not

It does not authorize tagging or publishing from a hygiene or docs PR. Tags
are a separate, explicit step after merge.
