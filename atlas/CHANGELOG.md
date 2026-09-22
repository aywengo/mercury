# Changelog

All notable changes to **Mercury Atlas** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-22

First working release: the knowledge service described in
[`docs/knowledge-base.md`](../docs/knowledge-base.md) sections 11 and 15.

**Not published yet at the time this entry was written**: this entry moves the release into
place (the notes file, the docs and the tests that hold them to the registry). `0.1.0` is not
on the npm registry. The registry comparison in `test/releaseDocs.test.ts` keeps this honest:
once `0.1.0` is on the registry this warning must come off and the release notes must offer
the install — and not before.

### Added

- The note store: notes with kinds, scopes and tiers, deduplicated by `claim_hash`, with corroboration
  counted from `note_sources` on every read rather than cached.
- A gapless per-project `seq` allocated inside `BEGIN IMMEDIATE`, so a cursor is a complete description
  of "everything since I last asked". Transitions out of `promoted` consume a seq too, which is how a
  replica learns to drop a note that was retired.
- The `/v1` HTTP surface: contribution with per-item answers and an idempotency key, the cursor feed,
  bootstrap, curation, and the project and contributor registries.
- Two token classes. Contributor tokens are stored only as SHA-256; `hostId` comes from the token
  binding, never the request body.
- Redaction on write and again on every read, so adding a value to `ATLAS_SECRETS` takes effect
  immediately rather than requiring a backfill.
- `/healthz` in the shape Fleet already probes, and `/metrics` in Prometheus text format.
- The `atlas` CLI: `serve`, `migrate`, `project`, `contributor`, `metrics`, `version`.
- Refusal to start on a non-loopback bind without TLS.
- `atlas/test/` and the coupling test enforcing that `atlas/` imports nothing from `src/` or `fleet/`.

### Not in this release

The Mercury host side is a different product with its own release train
([`@aywengo/mercury`](https://www.npmjs.com/package/@aywengo/mercury)). The host-side transport
described in [`docs/knowledge-base.md`](../docs/knowledge-base.md) sections 12-14 lives there,
and has shipped on the host's schedule (host phases 1-5 of the same design); nothing in this
package imports it, by the coupling rule of section 11.6. Atlas itself runs with no contributors
until an operator seeds them — `atlas contributor add` or the `ATLAS_CONTRIBUTORS_FILE`, both
documented in [`atlas/README.md`](README.md).
