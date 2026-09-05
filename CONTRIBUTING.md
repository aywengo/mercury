# Contributing to Mercury

The [Code of Conduct](CODE_OF_CONDUCT.md) applies to all participation.

## Prerequisites

- Node.js ≥ 22.18
- `git`

```bash
npm ci
npm run typecheck
npm test
```

`npm test` runs the core suite and the Fleet suite. Focused files:

```bash
node --test --test-timeout=180000 test/releaseHygiene.test.ts
node --test --test-timeout=180000 fleet/test/version.test.ts
```

See [`docs/testing.md`](docs/testing.md) and [`QUICKSTART.md`](QUICKSTART.md).

## Pull requests

- Branch from `main`.
- One GitHub issue → one PR. Unrelated findings become new issues.
- Do not add AI or tool attribution trailers to commits or PR bodies.
- Keep the change in the owning layer: host code under `src/`, Fleet under `fleet/` (Fleet must not import `src/`).

Documentation ownership: [`docs/README.md`](docs/README.md). How to cut a release: [`docs/releasing.md`](docs/releasing.md).

## Security

Do not file public issues for unfixed vulnerabilities. Follow [`SECURITY.md`](SECURITY.md).
