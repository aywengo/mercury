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

## The CLI

`mercuryctl` exists and ships in the host package, so its version is the package
version — there is no independent CLI version to keep in sync. Tag
`cli-vX.Y.Z` only when `docs/releases/cli/X.Y.Z.md` exists; the workflow
creates the release from that file alone, so the notes are the release body
and a stub file publishes a stub release.

`test/releaseHygiene.test.ts` enforces that the notes file for the current
package version exists, names that version, and is not a stub.

Verify before tagging, beyond `npm test`:

```bash
npm pack && rm -rf /tmp/cli-verify && mkdir -p /tmp/cli-verify/consumer/node_modules/@aywengo
tar -xzf aywengo-mercury-*.tgz -C /tmp/cli-verify/consumer/node_modules/@aywengo/mercury --strip-components=1
node /tmp/cli-verify/consumer/node_modules/@aywengo/package/dist/client/bin.js --version
```

That path contains `node_modules` deliberately: Node refuses to strip types
under `node_modules`, which is how the first published artifact shipped
unrunnable and every source-tree test green.

## What this document is not

It does not authorize tagging or publishing from a hygiene or docs PR. Tags
are a separate, explicit step after merge.
