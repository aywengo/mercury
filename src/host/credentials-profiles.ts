// Credential profiles: the CP-2 profile file (docs/credential-profiles-design.md §5.1, §5.2, §9,
// §10; issue #784).
//
// SCOPE: the profile FILE only - schema, loader, permission and overlap checks, and the offline
// `host credentials validate` surface. Nothing reads profiles when creating, claiming or driving a
// Run yet (that is CP-3/CP-4): a host with or without the file behaves exactly as today.
//
// Failure shape (§9): an absent file means "no profiles" and is NOT an error; a file that exists
// but is unreadable, malformed, too permissive, or carries overlapping repository patterns is a
// hard refusal naming the file and the field. Values are never printed - not in errors, not in
// validate output.

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function credentialProfilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'mercury', 'credential-profiles.json');
}

/** Same rule as bot-credentials.json: refuse anyone-but-owner readability. */
export function assertProfilesFileSafe(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    throw new Error(`cannot stat credential profiles file ${path}: ${(err as Error).message}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `refusing to read ${path}: it is readable by group or others (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). ` +
      'Run chmod 600 on it.',
    );
  }
}

export interface ProfileEnvValue {
  file?: string;
  value?: string;
}

export interface CredentialProfile {
  name: string;
  repositories: string[];
  owners: string[];
  env: Record<string, ProfileEnvValue>;
  git?: { authorName?: string; authorEmail?: string; httpsToken?: string };
  sandbox: boolean;
}

export interface CredentialProfiles {
  profiles: CredentialProfile[];
}

const NAME_RE = /^[a-z0-9-]{1,40}$/;
const FORBIDDEN_ENV_RE = /^MERCURY_/i;
const PROFILE_FIELDS: ReadonlySet<string> = new Set(['name', 'repositories', 'owners', 'env', 'git', 'sandbox']);

/**
 * Normalize a repository URL or pattern to the §5.2 id: `host/owner/name` (or `host/owner/*`),
 * scheme and `.git` removed, lowercased, SSH (`git@host:path`) and HTTPS forms equal. A trailing
 * `/*` after the owner is the org/user pattern. `localPath` repositories have no id and never
 * match a profile; they are not normalized here.
 */
export function normalizeRepositoryId(raw: string): string {
  const original = raw;
  let s = raw.trim();
  if (s === '') throw new Error('repository id is empty');
  const scp = /^(?:ssh:\/\/)?git@([^/:]+):(.+?)$/i.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^(?:https|ssh):\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error(`unsupported repository URL scheme in '${original}'`);
  s = s.replace(/\.git\/?$/i, '');
  s = s.replace(/^www\./i, '');
  s = s.toLowerCase();
  const segments = s.split('/').filter((p) => p !== '');
  if (segments.length < 2) throw new Error(`repository id '${original}' does not look like host/owner/name`);
  const [host, owner, name, ...extra] = segments;
  if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-z0-9-]+$/.test(owner)) {
    throw new Error(`repository id '${original}' does not look like host/owner/name`);
  }
  if (name === undefined) {
    // 'host/owner' alone is NOT the org pattern: only an explicit trailing '/*' is (§5.2). A bare
    // two-segment id is a malformed entry, and accepting it as a wildcard would silently broaden
    // the profile's credential scope to a whole owner.
    throw new Error(`repository id '${original}' must be host/owner/name or host/owner/* (add the explicit /* for an owner-wide pattern)`);
  }
  if (name === '*') return `${host}/${owner}/*`;
  if (extra.length > 0 || !/^[a-z0-9._-]+$/.test(name)) {
    throw new Error(`repository id '${original}' does not look like host/owner/name`);
  }
  return `${host}/${owner}/${name}`;
}

interface RawProfile {
  name?: unknown;
  repositories?: unknown;
  owners?: unknown;
  env?: unknown;
  git?: unknown;
  sandbox?: unknown;
  [k: string]: unknown;
}

/** Validate ONE profile object; returns the typed profile. Throws with the offending field named. */
function validateProfile(raw: RawProfile, seenNames: Set<string>): CredentialProfile {
  const where = `profile '${String(raw.name ?? '<unnamed>')}'`;
  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELDS.has(key)) {
      throw new Error(
        `${where}: unknown field '${key}'` +
        (key === 'repo' ? " (did you mean 'repositories'?)" : ''),
      );
    }
  }
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) {
    throw new Error(`${where}: name must match [a-z0-9-]{1,40}, got '${String(raw.name)}'`);
  }
  const name = raw.name;
  const where2 = `profile '${name}'`;
  if (seenNames.has(name)) throw new Error(`${where2}: duplicate profile name`);
  seenNames.add(name);

  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) {
    throw new Error(`${where2}: repositories must be a non-empty array of repository ids`);
  }
  const repositories = (raw.repositories as unknown[]).map((r) => {
    if (typeof r !== 'string') throw new Error(`${where2}: repositories entries must be strings`);
    return normalizeRepositoryId(r);
  });

  if (!Array.isArray(raw.owners) || raw.owners.length === 0) {
    throw new Error(`${where2}: owners must be a non-empty array of owner ids`);
  }
  const owners = (raw.owners as unknown[]).map((o) => {
    if (typeof o !== 'string' || o.trim() === '') throw new Error(`${where2}: owners entries must be non-empty strings`);
    if (o === '*' || o.includes('*')) throw new Error(`${where2}: owners must not contain wildcards ('${o}')`);
    return o.trim();
  });

  if (raw.env !== undefined && (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env))) {
    throw new Error(`${where2}: env must be an object keyed by variable name`);
  }
  const env: Record<string, ProfileEnvValue> = {};
  for (const [key, value] of Object.entries((raw.env ?? {}) as Record<string, unknown>)) {
    if (FORBIDDEN_ENV_RE.test(key)) {
      throw new Error(`${where2}: env '${key}' matches MERCURY_ which the host reserves; profiles must not override host configuration`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${where2}: env '${key}' must be { "file": path } or { "value": string }`);
    }
    const v = value as { file?: unknown; value?: unknown };
    const keys = Object.keys(v);
    if (keys.length !== 1 || (keys[0] !== 'file' && keys[0] !== 'value')) {
      throw new Error(`${where2}: env '${key}' must have exactly one of 'file' or 'value'`);
    }
    if (keys[0] === 'file') {
      if (typeof v.file !== 'string' || v.file.trim() === '') throw new Error(`${where2}: env '${key}.file' must be a non-empty path`);
      env[key] = { file: v.file };
    } else {
      if (typeof v.value !== 'string' || v.value === '') throw new Error(`${where2}: env '${key}.value' must be a non-empty string`);
      env[key] = { value: v.value };
    }
  }

  let git: CredentialProfile['git'];
  if (raw.git !== undefined) {
    if (typeof raw.git !== 'object' || raw.git === null || Array.isArray(raw.git)) {
      throw new Error(`${where2}: git must be an object (authorName, authorEmail, httpsToken)`);
    }
    const g = raw.git as { authorName?: unknown; authorEmail?: unknown; httpsToken?: unknown };
    const gitFields: ReadonlySet<string> = new Set(['authorName', 'authorEmail', 'httpsToken']);
    for (const key of Object.keys(g)) {
      if (!gitFields.has(key)) {
        throw new Error(`${where2}: unknown field 'git.${key}' (expected authorName, authorEmail, httpsToken)`);
      }
    }
    git = {};
    if (g.authorName !== undefined) {
      if (typeof g.authorName !== 'string' || g.authorName.trim() === '') throw new Error(`${where2}: git.authorName must be a non-empty string`);
      git.authorName = g.authorName;
    }
    if (g.authorEmail !== undefined) {
      if (typeof g.authorEmail !== 'string' || g.authorEmail.trim() === '') throw new Error(`${where2}: git.authorEmail must be a non-empty string`);
      git.authorEmail = g.authorEmail;
    }
    if (g.httpsToken !== undefined) {
      if (typeof g.httpsToken !== 'string' || g.httpsToken === '') throw new Error(`${where2}: git.httpsToken must name an env entry`);
      if (!(g.httpsToken in env)) {
        throw new Error(`${where2}: git.httpsToken '${g.httpsToken}' does not name an entry in this profile's env`);
      }
      git.httpsToken = g.httpsToken;
    }
  }

  let sandbox = false;
  if (raw.sandbox !== undefined) {
    if (typeof raw.sandbox !== 'boolean') throw new Error(`${where2}: sandbox must be a boolean`);
    sandbox = raw.sandbox;
  }

  return { name, repositories, owners, env, git, sandbox };
}

/**
 * Load and validate the profile file. Absent file -> { profiles: [] } (§9: not an error). Anything
 * else wrong is a hard refusal naming the file and the field. Values never appear in errors.
 */
export function loadCredentialProfiles(env: NodeJS.ProcessEnv = process.env): CredentialProfiles {
  const path = credentialProfilesPath(env);
  if (!existsSync(path)) return { profiles: [] };
  assertProfilesFileSafe(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Intentionally no parse-error text: SyntaxError messages can embed excerpts of the file's
    // contents (e.g. an unquoted secret), and this module never prints values. Position only.
    throw new Error(`${path}: malformed JSON (fix the syntax; position visible in an editor, not here)`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: top level must be an object with a 'profiles' array`);
  }
  const profilesRaw = (parsed as { profiles?: unknown }).profiles;
  if (!Array.isArray(profilesRaw)) throw new Error(`${path}: 'profiles' must be an array`);
  const seen = new Set<string>();
  const profiles = profilesRaw.map((p) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new Error(`${path}: each profile must be an object`);
    }
    return validateProfile(p as RawProfile, seen);
  });
  // Overlapping repository patterns across profiles (§5.2/§9): two profiles claiming the SAME
  // normalized id (or one claiming a wildcard covering the other's id) are ambiguous at resolution
  // time and refused at load.
  const claims = new Map<string, string>();
  for (const profile of profiles) {
    for (const repo of profile.repositories) {
      const existing = claims.get(repo);
      if (existing !== undefined && existing !== profile.name) {
        throw new Error(`${path}: repository id '${repo}' is claimed by both profile '${existing}' and profile '${profile.name}'; overlapping patterns are refused`);
      }
      claims.set(repo, profile.name);
    }
  }
  // A wildcard pattern overlaps any exact id under its owner:
  for (const profile of profiles) {
    for (const repo of profile.repositories) {
      if (!repo.endsWith('/*')) continue;
      const prefix = repo.slice(0, -1); // host/owner/
      for (const [other, ownerProfile] of claims) {
        if (ownerProfile === profile.name) continue;
        if (other.startsWith(prefix) && !other.endsWith('*')) {
          throw new Error(`${path}: repository id '${other}' (profile '${ownerProfile}') is covered by the wildcard '${repo}' (profile '${profile.name}'); overlapping patterns are refused`);
        }
      }
    }
  }
  return { profiles };
}

/** One line per check the offline validator ran; values never appear. */
export interface ProfilesValidationLine {
  ok: boolean;
  message: string;
}

/**
 * The `host credentials validate` check list (§10): file permissions, schema, overlaps, and the
 * existence/readability of `file:` sources. NEVER prints a value.
 */
export function validateCredentialProfiles(env: NodeJS.ProcessEnv = process.env): ProfilesValidationLine[] {
  const path = credentialProfilesPath(env);
  const lines: ProfilesValidationLine[] = [];
  const { profiles } = loadCredentialProfiles(env);
  if (profiles.length === 0) {
    lines.push({ ok: true, message: `no credential profiles (${path} absent or empty)` });
    return lines;
  }
  for (const profile of profiles) {
    for (const repo of profile.repositories) {
      lines.push({ ok: true, message: `profile '${profile.name}': repositories '${repo}'` });
    }
    for (const [key, value] of Object.entries(profile.env)) {
      if (value.file !== undefined) {
        const target = value.file.startsWith('~') ? join(homedir(), value.file.slice(1)) : value.file;
        // 'Present' must mean what drive time needs: a regular file this user can READ. A
        // directory or an unreadable file would fail at §9 drive time while existsSync said ok.
        let ok = false;
        let why = 'MISSING';
        try {
          statSync(target); // throws when absent
          accessSync(target, fsConstants.R_OK);
          ok = statSync(target).isFile();
          if (!ok) why = 'not a regular file';
        } catch {
          ok = false;
        }
        lines.push({
          ok,
          message: `profile '${profile.name}': env '${key}' source ${ok ? 'present' : why} (${target})`,
        });
      }
    }
  }
  lines.push({ ok: true, message: `${profiles.length} profile(s) valid` });
  return lines;
}
