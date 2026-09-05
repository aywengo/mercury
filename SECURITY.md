# Security policy

## Supported versions

| Product | Version | Supported |
| --- | --- | --- |
| Mercury host (`@aywengo/mercury`) | 0.1.x | Yes |
| Mercury Fleet (`@aywengo/mercury-fleet`) | 0.1.x | Yes |
| `mercuryctl` | — | Not released |

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

https://github.com/aywengo/mercury/security/advisories

Do not file a public issue for an unfixed vulnerability.

Please include:

- the product (`host` or `fleet`) and version (`mercury --version` or `fleet --version`);
- steps to reproduce;
- impact (who can do what that they should not).

Reports are reviewed by the repository owner. There is no published SLA or bounty.

## In scope

- authentication or owner-scoping bypass;
- sandbox escape (a constrained Run executing outside the container or with broader privileges than requested);
- secret leakage through the API, persisted events, or process logs for credentials Mercury observed or forwarded.

## Out of scope

These are documented limitations, not reportable defects unless they are worse than described in [`docs/status.md`](docs/status.md):

- redaction of a secret Mercury never observed or that an agent transformed;
- credentials that remain inside an agent process or a remote provider;
- destination-aware egress (named `allowedNetworks` entries are not an allowlist);
- token and cost budget fields (recorded, not enforced).
