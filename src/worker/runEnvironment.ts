// Credential profiles CP-4 (issue #897, docs/credential-profiles-design.md sections 6.1, 6.2, 8, 9):
// the local Run's base environment, built in the four section 6.1 layers instead of the worker's
// `process.env` wholesale. The worker calls buildRunEnvironment() per Run; adapters receive the
// result through `context.env` and use it as the spawn base. Values never appear in errors.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isStrippedEnvName } from '../config.ts';
import type { CredentialProfile } from '../host/credentials-profiles.ts';

export interface RunEnvironmentResult {
  /** The complete environment for the Run's local agent process (layers 1-3; layer 4 is the caller's). */
  env: Record<string, string>;
  /** Absolute path of the generated gitconfig, when one was written. */
  gitconfigPath?: string;
  /** Absolute path of the generated GH_CONFIG_DIR, when one was created. */
  ghConfigDir?: string;
  /** Exact-value secrets to register with the Run's redactor (section 8). */
  secrets: string[];
}

/**
 * A `file:` source missing or empty at drive time fails the Run with the section 9 message. There
 * is no fallback — never to the worker's environment, never to an empty value.
 */
export class CredentialSourceMissingError extends Error {}

/** Expand a leading `~` like the validate surface does. */
function expandTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function readSecretFile(profileName: string, varName: string, path: string): string {
  const target = expandTilde(path);
  let raw: string;
  try {
    // §5.1: values are read when a Run is driven, not at startup, so rotating a token means
    // replacing the file with no restart. A missing file at DRIVE time is the section 9 refusal.
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new CredentialSourceMissingError(`credential profile '${profileName}': env ${varName} source missing`);
    }
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    if (err instanceof CredentialSourceMissingError) throw err;
    throw new CredentialSourceMissingError(`credential profile '${profileName}': env ${varName} source missing`);
  }
  // A trailing newline is file hygiene, not part of the token; a WHITESPACE-ONLY file is empty.
  const value = raw.replace(/\r?\n$/, '');
  if (value.trim() === '') {
    throw new CredentialSourceMissingError(`credential profile '${profileName}': env ${varName} source missing`);
  }
  return value;
}

/**
 * The generated `<run-dir>/gitconfig` (section 6.2): the profile's author and committer, and,
 * when `git.httpsToken` is set, a credential helper scoped to the profile's repository hosts that
 * answers `username=x-access-token` with the token from its environment variable — the token never
 * appears in the file. The helper shell references the variable by NAME; the variable itself is
 * injected into the Run environment by the profile's `env` layer.
 */
/** Quote a gitconfig value: wrap in double quotes, escape backslash and quote (git-config(1)).
 *  Control characters are refused at load (credentials-profiles.ts), so a value can never start
 *  a new section; quoting keeps `;`, `#` and leading/trailing space literal (#977 review). */
function gitconfigValue(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** CP-4 review blocker 2 (#977): ssh for git with no agent, no keys and no config. The host's
 *  `~/.ssh` and its agent socket would otherwise authenticate a Run that matches no profile,
 *  defeating the strict default (#954). Profiles in CP-4 carry HTTPS credentials only; an SSH
 *  profile is CP-5's business and would replace this command explicitly. */
/** Names whose `value:` is treated as a secret: the profile's HTTPS token variable, or a name
 *  that says what it is. Everything from a `file:` source is a secret regardless. */
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|PAT|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
export function isSecretEnvName(name: string, profile: CredentialProfile): boolean {
  return name === profile.git?.httpsToken || SECRET_NAME_RE.test(name);
}

export const NO_SSH_COMMAND =
  'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes';

export function renderGitconfig(profile: CredentialProfile): string {
  const lines: string[] = [];
  if (profile.git?.authorName || profile.git?.authorEmail) {
    lines.push('[user]');
    if (profile.git.authorName) lines.push(`\tname = ${gitconfigValue(profile.git.authorName)}`);
    if (profile.git.authorEmail) lines.push(`\temail = ${gitconfigValue(profile.git.authorEmail)}`);
  }
  if (profile.git?.httpsToken) {
    // One section per distinct host, so the helper is scoped to the profile's repositories only.
    const hosts = new Set<string>();
    for (const repo of profile.repositories) {
      const host = repo.split('/')[0];
      if (host) hosts.add(host);
    }
    for (const host of [...hosts].sort()) {
      lines.push(`[credential "https://${host}"]`);
      // The helper reads the variable at call time. Quoting keeps an exotic variable name safe;
      // the schema (section 5.1) already guarantees it is a plain JSON object key, and it can
      // never be a MERCURY_ name or contain a newline.
      // The quotes must be BACKSLASH-ESCAPED: git config strips unescaped double quotes from the
      // value before handing it to `sh -c`, which would turn `test "$1" = get` into `test $1 = get`
      // and break on any quoting edge (measured: unescaped quotes yield a syntax error in sh).
      // Git config values process backslash escapes, so a newline inside the printf format must
      // be written as a DOUBLED backslash (\\n in the file -> \n for sh -> newline from printf),
      // and the shell quotes as \" (git config unescapes them for sh). Measured, not assumed.
      // The value is DOUBLE-QUOTED as a whole: a bare `;` inside it would start a git config
      // comment and truncate the helper (measured). Inside the quotes, \" survives to sh as "
      // and \\\\n survives as \\n for printf to turn into a newline.
      lines.push(
        `\thelper = "!f() { test \\"$1\\" = get && printf 'username=x-access-token\\\\npassword=%s\\\\n' \\"$` +
        profile.git.httpsToken + `\\"; }; f"`,
      );
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/**
 * Build the local Run's base environment (section 6.1 layers 1-3).
 *
 * 1. The worker's environment minus GH_/GITHUB_/GIT_/MERCURY_ prefixed names.
 * 2. Host-config isolation: GIT_CONFIG_GLOBAL=<run-dir>/gitconfig, GIT_CONFIG_NOSYSTEM=1,
 *    GH_CONFIG_DIR=<run-dir>/gh. Without this a stripped environment would still reach the host
 *    user's osxkeychain or gh credential helpers through ~/.gitconfig.
 * 3. The resolved profile's env, when the Run has one; `file:` values are read here, at drive
 *    time, and a missing or empty source fails the Run (section 9).
 *
 * Layer 4 (adapter `config.env`) stays where it is today — the adapter merges it LAST, and a
 * stripped name there is refused at load, never silently brought back.
 */
export function buildRunEnvironment(opts: {
  workerEnv: NodeJS.ProcessEnv;
  runDir: string;
  profile: CredentialProfile | null;
}): RunEnvironmentResult {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.workerEnv)) {
    if (value === undefined) continue;
    if (isStrippedEnvName(name)) continue;
    // The ssh agent socket is a source-control credential channel too (#977 review).
    if (name === 'SSH_AUTH_SOCK') continue;
    env[name] = value;
  }
  env.GIT_SSH_COMMAND = NO_SSH_COMMAND;

  const gitconfigPath = join(opts.runDir, 'gitconfig');
  const ghConfigDir = join(opts.runDir, 'gh');
  if (opts.profile === null) {
    // A no-profile Run is STILL isolated (section 6.1: "Every local Run is affected"): an empty
    // gitconfig and an empty gh config dir, so nothing from the host user leaks in. The empty
    // gitconfig must exist — GIT_CONFIG_GLOBAL pointing at an absent file is silently ignored by
    // git, which would send credential lookups back to ~/.gitconfig (acceptance 2).
    writeFileSync(gitconfigPath, '');
    mkdirSync(ghConfigDir, { recursive: true });
    env.GIT_CONFIG_GLOBAL = gitconfigPath;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GH_CONFIG_DIR = ghConfigDir;
    return { env, gitconfigPath, ghConfigDir, secrets: [] };
  }

  const gitconfig = renderGitconfig(opts.profile);
  writeFileSync(gitconfigPath, gitconfig);
  mkdirSync(ghConfigDir, { recursive: true });
  env.GIT_CONFIG_GLOBAL = gitconfigPath;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GH_CONFIG_DIR = ghConfigDir;

  const secrets: string[] = [];
  for (const [name, spec] of Object.entries(opts.profile.env)) {
    if (isStrippedEnvName(name)) {
      // Profiles inject the very names layer 1 strips — that is the design (GH_TOKEN etc.).
      // Set them AFTER the strip, here in layer 3, where the profile governs them.
    }
    if (spec.value !== undefined) {
      env[name] = spec.value;
      // A literal `value:` is configuration unless it is the HTTPS token or names itself a secret
      // (#977 review): registering `GH_HOST=github.com` redacted every repository URL on the
      // host, before profile resolution, for every Run. `file:` sources are always secrets.
      if (isSecretEnvName(name, opts.profile)) secrets.push(spec.value);
    } else if (spec.file !== undefined) {
      const value = readSecretFile(opts.profile.name, name, spec.file);
      env[name] = value;
      secrets.push(value);
    }
  }

  // Section 6.2: author/committer variables for tools that bypass config.
  if (opts.profile.git?.authorName) {
    env.GIT_AUTHOR_NAME = opts.profile.git.authorName;
    env.GIT_COMMITTER_NAME = opts.profile.git.authorName;
  }
  if (opts.profile.git?.authorEmail) {
    env.GIT_AUTHOR_EMAIL = opts.profile.git.authorEmail;
    env.GIT_COMMITTER_EMAIL = opts.profile.git.authorEmail;
  }

  return { env, gitconfigPath, ghConfigDir, secrets };
}
