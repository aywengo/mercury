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
   **Fleet's first release is the one exception.** The npm package is Fleet's only installable artifact --
   a Fleet release attaches no bundle and there is no Fleet formula -- and trusted publishing is
   configured on the package page, which cannot exist before the package does. So the very
   first `@aywengo/mercury-fleet` publish needs a credential; a `fleet-vX.Y.Z` tag pushed without one is
   refused up front rather than creating a GitHub Release that ships nothing. Once the package exists the
   tag path needs no secret, and the workflow discovers this by asking the registry, so nothing has to be
   edited when the bootstrap happens. The command, which the refusal prints as well:

   ```bash
   cd fleet                      # REQUIRED: from the repo root this publishes @aywengo/mercury, not fleet
   cp ../LICENSE LICENSE         # fleet/ declares MIT but ships no LICENSE file
   npm version --no-git-tag-version 0.0.1-bootstrap
   npm publish --access public --tag bootstrap
   ```

   **Publish a throwaway version, never the version you are releasing.** npm refuses to publish the same
   version twice. A bootstrap at `0.1.0` consumes it, so the `fleet-v0.1.0` tag -- the one that carries
   SLSA provenance and creates the GitHub Release -- then fails with "cannot publish over it", and the
   only way out is to bump the version you were trying to ship. A prerelease cannot collide with a real
   release version. The bootstrap also carries no provenance, because a token publish cannot attest; the
   tagged release is what adds it.

   The bump is **local and disposable**: `fleet/test/version.test.ts` asserts `fleet/package.json`
   equals `fleet/version.ts`, so the suite goes red while it is present, and committing it would make
   the bootstrap version the released one. Publish, then discard it before doing anything else:

   ```bash
   git checkout -- fleet/package.json
   ```

   It cannot be done from a copy outside the repository: `prepare` compiles `dist/` with
   `../node_modules/typescript`, which only resolves inside the checkout.

   Expect the bootstrap artifact to report the wrong version. `fleet --version` prints the compiled
   `FLEET_VERSION` constant, not `package.json`, so a `0.0.1-bootstrap` tarball prints
   `mercury-fleet 0.1.0`. Measured by installing the published bootstrap from the registry. Harmless
   for a placeholder, and it is one more reason the bootstrap must never be the release version.

   Run it from a clean checkout, with an npm credential that can publish, then immediately create the
   trusted publisher so the next release needs no secret. This needs interactive 2FA, so it is a human
   step; `--dry-run` validates the shape without one:

   ```bash
   npm trust github @aywengo/mercury-fleet --file release.yml --repo aywengo/mercury \
     --allow-publish --allow-stage-publish
   ```

   `--allow-stage-publish` is required, not optional: the workflow uses `npm stage publish` whenever the
   runner's npm has it, and a publisher created with `--allow-publish` alone refuses that command.

5. **Rehearse before you tag.** A tag is a published artifact, so a mistake in the release job costs a
   burned version number. Run the workflow by hand instead:

   ```bash
   gh workflow run release.yml --repo aywengo/mercury --ref main
   ```

   It does everything a real release does -- tag parsing, the manifest and notes checks, install, the
   Homebrew bundle, the OIDC exchange, and the real `npm publish` pack -- then stops short of the three
   things that touch the outside world: `npm publish`, `gh release create`, and the formula push. It
   takes no input and cannot publish; the mode is derived from the event name, so a tag push is never a
   rehearsal and a rehearsal is never a release.

   The OIDC part is worth running before tagging, with one limit stated up front: the rehearsal cannot
   mint a tag-subject token, so its exchange result is evidence about the claims and about npm's endpoint,
   not a prediction of the tag push. The log prints the claims npm
   matches the run against -- `repository_owner`, `repository`, and the workflow filename inside
   `job_workflow_ref` -- which is worth reading, because npm reports a trusted-publishing mismatch as an
   opaque registry 404 with no reason.

   It then attempts the exchange npm itself performs, the POST to
   `/-/npm/v1/oidc/token/exchange/package/<name>` that turns the id token into a short-lived publish
   credential, and asks the same question of an unrelated package as a control. Read it this way:

   - `ACCEPTED` for this package means npm exchanged the token this rehearsal was holding. It does **not**
     settle a real publish: a rehearsal is a `workflow_dispatch` run, so its `sub` ends
     `:ref:refs/heads/<branch>`, while a tag push carries `:ref:refs/tags/<tag>`. A publisher scoped to a
     tag pattern can refuse one and accept the other. The claims worth reading are the ones that do carry
     over -- `repository_owner`, `repository` and the workflow filename in `job_workflow_ref`.
   - `REFUSED` for this package **and a different answer** for the control means a configuration is
     being evaluated and does not match. The rehearsal fails, and the log lists the fields to check,
     starting with the workflow filename, which npm wants as a bare name (`release.yml`, not a path).
   - `REFUSED` for this package **and the same answer** for the control means nothing. That is what the
     registry says to a token it will not exchange, from anywhere. The rehearsal continues, because a
     check that is red on every run is a check people stop reading.

   That third case is the one observed today: this package and `left-pad` are refused identically, on
   both candidate audiences. So the probe currently establishes nothing about this repository's trust
   configuration, and it is deliberately silent rather than confident. The reason it exists at all is
   that `npm publish --dry-run` does not authenticate -- before it, a green rehearsal said nothing
   whatever about npm's trust -- and the day npm answers the two packages differently, this says
   something no rehearsal could before. What settles trust is the publish itself.

6. Once the rehearsal is green, on the same merge commit:

   Tag the product you are shipping. Host and Fleet are independent version streams, so a Fleet-only
   release gets a `fleet-` tag and nothing else:

   ```bash
   product=host    # or: fleet
   display=$([ "$product" = fleet ] && echo Fleet || echo host)
   git tag -a "${product}-vX.Y.Z" -m "Mercury ${display} vX.Y.Z"
   git push origin "${product}-vX.Y.Z"
   ```

   When both ship together, push both tags from the same commit; each runs its own release job.

7. [`.github/workflows/release.yml`](../.github/workflows/release.yml) creates the GitHub Release from
   the notes file for that tag and submits the package to npm with provenance. It handles `host` and
   `fleet` tags only; any other tag is refused.

8. **A green run does not mean the version is installable.** The job submits with `npm stage publish`,
   which defers proof-of-presence to a maintainer, so `npm install` will not resolve the version until it
   is approved. The release body names the id and gives the command:

   ```bash
   npm stage approve <stage-id>     # needs a 2FA code; run it locally
   ```

   `npm stage` needs **npm 11.15.0 or newer** -- it is not a plugin, and older npm answers
   `Unknown command "stage"`. Check with `npm --version`; if you are behind, either update npm
   (`npm install -g npm@latest`) or use the web UI below, which needs no particular npm version.

   Or approve on npmjs.com under **Published packages -> Staged packages**. Until then the GitHub Release
   asset and, for a host release, the Homebrew formula are live, but the npm package is not -- so a user
   following an `npm install -g` instruction gets the previous version. If a run goes green and nobody
   approves, that is the gap to close; it is not a sign the job failed.

## Publishing credential

**There is none for the host, and that is the intended steady state.** Fleet's first publish is the one
exception and needs a credential, as the procedure above says; after that it needs none either. The host
publishes through npm's trusted publishing: the workflow exchanges the GitHub Actions OIDC id-token for a short-lived credential, so no
long-lived secret exists in the repository. `NPM_TOKEN` was deleted once trusted publishing was
configured. The workflow still prefers `NPM_TOKEN` if the secret is ever re-added, and refuses the tag
before creating any release if neither credential is available.

### Testing trusted publishing without publishing anything

The exchange probe on a normal rehearsal holds a **branch**-subject token, so it cannot tell you what a tag
push will do. It can be made to hold a tag-subject token, and this is the only way to ask npm about trust
before you spend a version number.

`workflow_dispatch` reads the workflow from the ref it is given, and the OIDC subject is built from that ref.
So tag the commit you would release, with a name that matches **neither** `host-v*.*.*` **nor**
`fleet-v*.*.*`, and dispatch against it:

```bash
git tag probe-host-v0.0.0 && git push origin probe-host-v0.0.0
gh workflow run release.yml --repo aywengo/mercury --ref probe-host-v0.0.0
git push origin :refs/tags/probe-host-v0.0.0    # nothing references it afterwards
```

The name matters twice over. It must not match the release triggers, or pushing it performs a real release;
and `host-v0.0.0-probe` **does** match `host-v*.*.*`, because `*` swallows `-probe`. `test/releaseDocs.test.ts`
asserts the documented name cannot trigger a release. The run stays a rehearsal, because `DRY_RUN` comes from
the event name and not the ref, so it publishes nothing, creates no GitHub Release and touches no formula.

Read the `oidc sub` line to confirm you actually got a tag subject -- `...:ref:refs/tags/probe-...` -- and
then read the exchange. `test/releaseDocs.test.ts` also pins that the probe tag name in this document is the
one the guard checks, so the two cannot drift apart.

### Confirming the OIDC exchange works

**It does.** Run the rehearsal and read npm's own log:

```
npm http fetch POST 201 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@aywengo%2fmercury
npm verbose oidc Successfully retrieved and set token
```

`201` plus "Successfully retrieved and set token" means npm issued a real publish credential for this
repository. Trusted publishing is configured and working; nothing on npmjs.com needs changing.

The only reliable way to see this is to let **npm** perform the exchange:

```bash
npm publish --dry-run --access public --tag rc --provenance --loglevel verbose
```

`--loglevel verbose`, never `silly`: every message in npm's `lib/utils/oidc.js` is `log.verbose`, while
`silly` additionally dumps the exchange response body -- which is a live publish credential that anyone
with read access to the run log could use.

`--dry-run` still authenticates. npm's `lib/commands/publish.js` calls `await oidc(...)` before it looks at
`dryRun` at all, so the exchange is real and its outcome is logged.

**What the rehearsal does not prove.** `--provenance` has no effect on this exchange: `oidc()` decides
whether to run purely from `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which
`permissions: id-token: write` provides -- not from the flag. It is kept so the command matches the real
release line, not because it contributes. And because `--dry-run` returns before `libpub` is ever called,
`buildMetadata` and `generateProvenance` never run: **a green rehearsal says nothing about provenance
signing.** Signing talks to sigstore and the Rekor transparency log, and if either is unreachable the real
release fails -- before staging anything, so nothing is left half-published. A rehearsal that passes and a
release that fails on provenance are both normal, and the second is not a credentials problem. Every failure path inside `oidc.js` is
`log.verbose`, which is why the log level has to be raised -- at the default level a rehearsal proves the
tarball and nothing about credentials.

**Do not reproduce this exchange with `curl`.** A hand-rolled reproduction in this workflow reported
`unauthorized` for every package for days, and every wrong conclusion in the release notes and issue
history traces back to it. It was not equivalent to npm's request: npm sets
`//registry.npmjs.org/:_authToken` to the id_token and lets `npm-registry-fetch` build the call, while the
probe sent a bearer header. The disproof was visible in the log the whole time -- the probe returned
`unauthorized` for the bearer value `not.a.real.jwt`. **A probe that cannot distinguish a valid GitHub OIDC
token from a fake string is measuring its own request, not the registry's trust decision.**

Two things that are genuinely true and worth knowing, both unrelated to that probe:

- This repository presents the **immutable** subject format,
  `repo:aywengo@800531/mercury@1349412409:ref:...`, because it was created after 2026-07-15. Read it with
  `gh api repos/aywengo/mercury/actions/oidc/customization/sub --jq .sub_claim_prefix`. It is **not**
  blocking anything -- npm exchanges the token anyway -- but it is the kind of claim that gets mistaken for
  a cause, so it is recorded here as measured and harmless.
- A `sub` carrying numeric IDs is worth knowing about before adding any *other* OIDC trust (AWS, GCP,
  Vault), because several providers match on the name-only shape and will not match this one.

**The fallback is a short-lived token, and it does not cost you provenance.** The `host-v0.1.0-rc1` run
authenticated with `NPM_TOKEN` and still signed and published provenance:

```
publish auth: NPM_TOKEN
npm notice stage Provenance statement published to transparency log: ...logIndex=2742821710
```

npm mints a separate OIDC token for sigstore, independent of the trusted-publisher exchange, so Fulcio
accepts it either way. Verify a published version carries attestations:

```bash
curl -sS --max-time 30 -o /dev/null -w '%{http_code}\n' \
  "https://registry.npmjs.org/-/npm/v1/attestations/@aywengo%2fmercury@0.1.0-rc1"
```

`200` means the version has attestations; `404` means it does not. `-f` is deliberately absent: the
answer you want is often an HTTP error, and `curl -f` exits non-zero on 404, so the command would both
print the result and report failure. A token publish is a workaround for a
blocked exchange, not the steady state: delete the secret afterwards, because the workflow prefers
`NPM_TOKEN` whenever it is present and would keep using it.

Two things to know about the npm-side configuration, both on the package's *Trusted Publisher* settings
page (which only exists once the package has been published at least once):

- It matches **owner, repository and workflow filename** -- `aywengo`, `mercury`, `release.yml`. Not a
  branch, so tag-push releases are covered.
- It matches those fields **only if npm gets that far.** GitHub mints the `sub` claim in two shapes, and
  the one this repository presents changed underneath the configuration:

  | | subject GitHub presented | who checked it | result |
  | --- | --- | --- | --- |
  | 2026-09-06, `host-v0.1.0-rc1` | `repo:aywengo/mercury:ref:refs/tags/...` | sigstore Fulcio | **certificate issued** |
  | 2026-09-07 onward | `repo:aywengo@800531/mercury@1349412409:ref:...` | npm registry | **exchange refused** |

  The first row is not a guess: the provenance statement that run signed is in the public Rekor log at
  `logIndex=2742821710`, and its certificate SAN is
  `https://github.com/aywengo/mercury/.github/workflows/release.yml@refs/tags/host-v0.1.0-rc1`. sigstore
  derives that URI from a name-only `sub`. Verify it yourself:

  ```bash
  curl -fsS --max-time 30 "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=2742821710" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);
      const b=JSON.parse(Buffer.from(e[Object.keys(e)[0]].body,"base64").toString());
      process.stdout.write(Buffer.from(b.spec.signatures[0].verifier,"base64").toString())})' \
    > /tmp/leaf.pem
  openssl x509 -in /tmp/leaf.pem -noout -text | grep -A1 "Subject Alternative Name"
  ```

  The rehearsal prints `!! sub carries numeric repository IDs` when the ID shape is in use. That is a
  diagnostic, not a verdict -- see issue #335 for what is and is not established. The setting is
  **Settings -> Actions -> General -> OIDC subject claim format**, which GitHub documents as an opt **in**
  to the ID-bearing format; this repository already presents that format, and the reference describes no
  way back for a repository created after the cutoff.
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
