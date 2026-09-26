# Credential profiles: per-repository GitHub identity on one host

Status: **Specification. Nothing in this document is implemented.** Section 2 describes current
behaviour and was checked against the tree at `main` on 2026-09-26; everything else describes the
intended model. Until this lands, the nightly work uses the interim in §12: one dedicated host per
identity.

## 1. Problem

A Mercury host has exactly one set of source-control credentials: whatever is in the worker's
environment and in the host OS user's git and `gh` configuration. Every Run on the host gets them,
whoever created it and whatever repository it targets. This works while a host serves one person on one
repository, and it breaks in three ordinary situations:

- **A bot identity on a shared host.** The nightly identity `mercury-nightly`
  (`nightly-self-development.md` §5) should act only in the nightly bot's Runs. Put in
  `mercury.env`, its token also reaches every other owner's local Runs.
- **Several repositories, several accounts.** One host running work for `aywengo/mercury` and for an
  unrelated client repository has no way to use a different GitHub account for each.
- **Commit authorship.** Commits are authored by whatever `git config` the host user has, even when
  the push is made with a bot's token.

## 2. Current behaviour

| Path | What it passes | Evidence |
| --- | --- | --- |
| Local adapters | the worker's **whole** environment, plus adapter-level `config.env` | `localAgentAdapter.ts:407`, `claudeCodeAdapter.ts:349`, `hermesAgentAdapter.ts:275`, `rpc/rpcClient.ts:117` (`...process.env`) |
| Workspace git (clone, worktree) | the whole environment plus prompt suppression; credential helpers from the host user's git config still apply | `workspaceManager.ts` `GIT_ENV` |
| Sandbox (Docker) | an allowlist; `GH_*`, `GITHUB_*`, `GIT_*` are **never** forwarded, even when listed in `MERCURY_SANDBOX_ENV` | `sandboxManager.ts` `NEVER_FORWARD` |
| Redaction | exact values of forwarded sandbox credentials and `MERCURY_SECRETS`; shape patterns cover GitHub classic (`gh[pousr]_`) and fine-grained (`github_pat_`) tokens | `domain/redact.ts:48-49`, `test/redact.test.ts:129` |
| Run record | `ownerId`, `repository` (+ optional `repositories`); no credential or project reference | `domain/types.ts` |

So local mode has one identity per host, and sandbox mode has no GitHub identity at all.

## 3. Goals

1. A host can hold several GitHub identities, each bound to a set of repositories and a set of
   owners.
2. A Run receives the credentials of at most one profile, and only if its owner is allowed to use
   that profile.
3. A Run that matches no profile receives **no** source-control credentials. Nothing is inherited
   from the worker's environment or the host user's configuration.
4. Commits made in a profile's Runs carry that profile's author and committer identity.
5. Credentials are never set, chosen or read through the API. Profiles are host-side configuration.
6. Every value a profile injects is redacted from events and logs by exact value.
7. Sandboxed Runs can receive a profile's credentials by explicit per-profile opt-in, replacing the
   blanket `GH_*` block.

## 4. Non-goals

- **A security boundary in local mode.** A local Run runs as the host OS user and can read that
  user's files. Profiles prevent accidental and default use of the wrong identity. They do not stop a
  hostile agent that reads `~/.config` directly. Isolation from a hostile agent is the sandbox's job.
- **Fleet-level projects.** `fleet-tenancy-design.md` partitions hosts among callers and never
  forwards credentials. That stays true. Profiles live on a host and complement tenancy (§11).
- **A secrets manager.** Profiles reference files on the host; vault and keychain integrations are
  out of scope.
- **Non-GitHub forges.** The model is forge-neutral (URL patterns, env, git identity), but only
  GitHub is specified and tested.

## 5. The model

### 5.1 The profile file

`${XDG_CONFIG_HOME}/mercury/credential-profiles.json`, mode 0600, owned by the host user. The host
refuses to start if the file exists with wider permissions (the same rule as `bot-credentials.json`).

```json
{
  "profiles": [
    {
      "name": "mercury-nightly",
      "repositories": ["github.com/aywengo/mercury"],
      "owners": ["bot-nightly", "aywengo"],
      "env": {
        "GH_TOKEN": { "file": "~/.config/mercury/secrets/mercury-nightly.pat" }
      },
      "git": {
        "authorName": "mercury-nightly",
        "authorEmail": "334104664+mercury-nightly@users.noreply.github.com",
        "httpsToken": "GH_TOKEN"
      },
      "sandbox": false
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Stable id, `[a-z0-9-]{1,40}`. Recorded on Runs; never secret. |
| `repositories` | Normalized repository ids (§5.2). Exact match or a trailing `/*` for an org or user. |
| `owners` | Run owners allowed to use this profile. Required and non-empty. No wildcard. |
| `env` | Variables injected into the Run. Values are `{ "file": path }` (read at use time) or `{ "value": … }`. Names matching `^MERCURY_` are refused. |
| `git.authorName` / `authorEmail` | Set as author and committer for git in the Run. |
| `git.httpsToken` | Name of an `env` entry that git uses as the HTTPS credential for the profile's repositories. |
| `sandbox` | Whether a sandboxed Run of this profile receives the profile's `env` (§7). Default `false`. |

`file:` values are read when a Run is driven, not at startup, so rotating a token means replacing the
file with no restart. A missing or empty file fails the Run with a clear reason (§9); it never falls
back to anything else.

### 5.2 Repository ids

URLs are normalized to `host/owner/name`: lowercase host and path, scheme and `.git` removed, SSH
(`git@github.com:a/b.git`) and HTTPS forms equal. A `localPath` repository has no id and matches no
profile.

### 5.3 Resolution

For a Run, collect the ids of `repository` and every entry of `repositories`.

1. **No id matches any profile.** The Run gets no profile (§6.1: clean environment, no
   credentials).
2. **All matched ids match exactly one profile, and the Run's owner is in its `owners`.** The Run
   uses that profile. Ids that match nothing are allowed alongside, such as a public dependency
   checkout.
3. **The ids match two different profiles.** The Run is refused. One Run, one identity.
4. **The id matches a profile whose `owners` does not include the Run's owner.** The Run is refused.
   A repository claimed by a profile is usable only by that profile's owners, so no other caller can
   point a Run at `aywengo/mercury` and receive `mercury-nightly`'s token.

Overlapping patterns (`github.com/a/*` and `github.com/a/b` in different profiles) are rejected when
the file loads, so resolution never has to choose between them.

### 5.4 When resolution runs

- **At creation** (`POST /api/runs`): cases 3 and 4 return 403 with the profile **name** and the
  reason, so the caller sees the problem immediately. The resolved name is stored on the Run as
  `credentialProfile` (nullable).
- **At claim and at resume, authoritatively**: the file may have changed since creation. If the result
  differs from the stored name (profile removed, owner dropped, repository re-bound), the Run fails with
  `credential profile changed since creation`. It is never silently driven under a different identity.
  This mirrors the Crew resume-parity rule (#722).

`credentialProfile` appears in Run detail and events. Profile contents never appear there.

## 6. Delivery into a local Run

### 6.1 The base environment

Local adapters stop passing `process.env` wholesale. The Run's environment is built in four layers:

1. The worker's environment **minus** `GH_*`, `GITHUB_*`, `GIT_*` and `MERCURY_*`.
2. Isolation from the host user's source-control configuration:
   `GIT_CONFIG_GLOBAL=<run-dir>/gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, `GH_CONFIG_DIR=<run-dir>/gh`.
   Without this, a stripped environment would still reach the host user's `osxkeychain` or `gh`
   credential helpers through `~/.gitconfig`.
3. The profile's `env`, if any.
4. Adapter `config.env`, as today. It is refused at load if it sets a name that step 1 strips,
   because adapter config must not bring back what profiles govern.

This changes behaviour for every local Run, including Runs with no profile, which lose the host
user's git credentials. That is the point: goal 3 turns an implicit, ambient credential into an
explicit one. The migration path is §12.

### 6.2 Git in the Run

The generated `<run-dir>/gitconfig` holds the profile's author and committer, and, if
`git.httpsToken` is set, a credential helper scoped to the profile's repository hosts. The helper
answers `username=x-access-token` and the token from the environment variable, so the token never
appears in the file. The `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables are set as well, for tools
that bypass config.

### 6.3 Workspace git

Workspace clone and fetch (`workspaceManager.ts`) use the same resolution and the same generated
config. Today they rely on the host user's credential helper, so a private repository clones only if
the host user can read it. After this change, a private repository clones only if the Run's profile
can.

## 7. Delivery into a sandboxed Run

`NEVER_FORWARD` keeps blocking `GH_*`, `GITHUB_*` and `GIT_*` **from the worker's environment**. A
profile with `sandbox: true` adds its own `env` values to the container, together with the generated
gitconfig mounted read-only. The distinction matters: the operator's ambient credentials still never
enter a container, and an explicitly bound profile credential can. Profiles with `sandbox: false`
behave as today in sandbox mode: no source-control credentials.

## 8. Redaction

Every value a profile injects joins the exact-value redaction set for that Run, regardless of length.
The operator declared these values secret, so the length threshold for guessed secrets does not
apply. Shape-based redaction already covers GitHub classic and fine-grained tokens (§2) and stays as the
floor.

## 9. Failure modes

| Situation | Behaviour |
| --- | --- |
| Profile file absent | No profiles. Every Run resolves to case 1 (clean, no credentials). |
| File unreadable, malformed, too permissive, or with overlapping patterns | Host refuses to start and names the file and the field. |
| `file:` secret missing or empty at drive time | Run fails: `credential profile '<name>': env GH_TOKEN source missing`. No fallback. |
| Resolution differs between creation and claim/resume | Run fails (§5.4). |
| Adapter `config.env` sets a stripped name | Host refuses to start. |

## 10. Operator surface

- `mercury host credentials validate`: offline check of the file (permissions, schema, overlaps,
  `file:` readability). Prints profile names and repository patterns, never values.
- `mercury host credentials resolve --owner <o> --repo <url>`: prints the profile the rules would
  select, or the refusal reason.
- `mercury host doctor` runs `validate` and warns when the host user has global git credential
  helpers or a `gh` login: they are harmless after §6.1, but they show that someone expects them to
  be used.

## 11. Relation to other designs

- **Fleet tenancy** partitions *hosts* among *callers*. Profiles partition *identities* among
  *repositories and owners* on one host. They compose: a tenancy project's hosts each carry the
  profiles that project needs, and Fleet still never sees a credential.
- **Dispatcher bot** (`dispatcher-bot-design.md`): a bot's owner (`bot-<alias>`) is listed in a
  profile's `owners`. The bot's templates name only the repository; they never name a profile or a
  credential.
- **Nightly self-development**: with profiles, the nightly bot can share a host with other work, and
  §12 is no longer needed.

## 12. Interim: one dedicated host per identity (in use now)

Until profiles ship, the nightly identity runs on a host, or a separate Mercury instance under its
own OS user, dedicated to it:

- `MERCURY_API_TOKENS` on that host contains only `bot-nightly` and the operator's token, so every Run
  there is nightly work and inheriting the whole environment gives the token to nobody else.
- `GH_TOKEN` is in that host's `mercury.env` (0600). Classic tokens are already redacted by shape;
  listing the value in `MERCURY_SECRETS` as well is optional.
- The host user's git is set to author as `mercury-nightly`
  (`334104664+mercury-nightly@users.noreply.github.com`) and to use `gh` as its credential helper
  (`gh auth setup-git`), which reads `GH_TOKEN` from the environment. Nobody runs `gh auth login` on
  that user.

**Migration to profiles:** create the profile file with the same token file and git identity,
`mercury host credentials validate`, restart, then remove `GH_TOKEN` from `mercury.env` and the
global git settings. The dedicated host can then accept other owners.

## 13. Testing

- Resolution: table-driven over §5.3 cases 1–4, SSH/HTTPS/`.git`/case variants, `repositories`
  mixes, and overlap rejection at load.
- Environment: a local Run's environment, captured by a probe harness, contains no `GH_*`, `GITHUB_*`,
  `GIT_*` or `MERCURY_*` from the worker, and exactly the profile's variables. Mutation: restoring
  `...process.env` fails it.
- Host-config isolation: with a host `~/.gitconfig` whose credential helper returns a sentinel, a Run
  with no profile cannot obtain the sentinel through `git credential fill`.
- Git identity: a commit made in a profile Run has the profile's author and committer.
- Creation/claim parity: editing the profile file between creation and claim fails the Run with the
  §5.4 reason.
- Sandbox: `sandbox: false` → container has no `GH_TOKEN`; `sandbox: true` → it has the profile's
  value and nothing from the worker's `GH_*`.
- Redaction: a Run that prints its token produces events with the value redacted, for a classic
  `ghp_` value, both by shape and by exact value.

## 14. Issue set (proposed, not filed)

| Id | Scope | Depends on |
| --- | --- | --- |
| CP-1 | ~~Redact classic GitHub token shapes~~: not needed, already covered (§2) | — |
| CP-2 | Profile file: schema, loader, permission and overlap checks, `host credentials validate` | — |
| CP-3 | Repository id normalization and resolution; creation-time refusal; `credentialProfile` on Runs; claim/resume parity; `host credentials resolve` | CP-2 |
| CP-4 | Local adapters: layered environment (§6.1), isolated git and gh config, generated gitconfig with identity and credential helper | CP-3 |
| CP-5 | Workspace git uses the resolved profile | CP-4 |
| CP-6 | Sandbox per-profile opt-in | CP-4 |
| CP-7 | Exact-value redaction of profile values; doctor checks; `configuration.md` and `operations.md`; §12 migration notes | CP-4 |

CP-1 was dropped after checking the tree (§16). CP-4 is the behaviour change
(§6.1) and ships behind a release note, since Runs without a profile lose ambient credentials.

## 15. Open questions

1. **Default for Runs matching no profile.** This design gives them no credentials (goal 3). The
   alternative is a `"default"` profile with `owners: ["*"]` for single-user hosts that want today's
   behaviour explicitly. The proposal is to allow a wildcard only on a profile named `default` with
   no `repositories`, but that is not decided.
2. **GitHub App tokens.** A profile could mint installation tokens from an App key instead of reading
   a PAT, which would solve the hourly-expiry problem noted in `operations.md`. Out of scope for v1;
   the `env` value shape leaves room for a `{ "githubApp": … }` source later.
3. **Per-profile budgets.** Tempting because a profile is a natural cost center, but budgets are not
   enforced anywhere in Mercury today (`status.md`), and this design does not start that.

## 16. Revision history

### 2026-09-26: CP-1 dropped

The first draft claimed classic GitHub tokens (`ghp_` …) were not redacted by shape. They are:
`domain/redact.ts:48` (`gh[pousr]_`), pinned by `test/redact.test.ts:129`. §2, §8, §12 and §14 were
corrected.

### 2026-09-26: initial specification

Written after the nightly identity was created. It records the interim (§12) that is in use
until this is implemented.
