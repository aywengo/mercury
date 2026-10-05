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
/** Redact the whole authority userinfo (with or without a password) before input reaches an error.
 * Exported for the CLI's argument diagnostics: `--repo`/`--repos` values can embed a credential in
 * the userinfo, and `unknown argument '...'` echoes the raw flag text. */
export function redactUserInfo(s: string): string {
  // '//<anything>@' -> '//[REDACTED]@': a bare token in the username slot (ftp://ghp_...@host)
  // must be covered too, not only user:password forms.
  return s.replace(/(\/\/)[^@\s/]+@/g, '$1[REDACTED]@');
}

export function normalizeRepositoryId(raw: string): string {
  const original = redactUserInfo(raw);
  let s = raw.trim();
  if (s === '') throw new Error('repository id is empty');
  // SCP form (git@host:path) AND the standard SSH URI form (ssh://git@host/path, and the bare
  // git@host/path written after ssh:// has been stripped). One regex covers both: after
  // 'ssh://' is removed, 'git@host/path' has the same shape as the colon form with '/' as the
  // separator. A user:password authority never matches git@, so credential-bearing URLs still
  // fall through to the shape errors (with the userinfo redacted in `original`).
  const scp = /^(?:ssh:\/\/)?git@([^/:]+)[:\/](.+?)$/i.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^(?:https|ssh):\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new Error(`unsupported repository URL scheme in '${original}'`);
  s = s.replace(/\.git\/?$/i, '');
  s = s.replace(/^www\./i, '');
  s = s.toLowerCase();
  const segments = s.split('/').filter((p) => p !== '');
  // Shape errors never quote the input: a repository entry can carry a credential in any position
  // (userinfo, scp path), and the operator has the file - the field is what matters (§9).
  if (segments.length < 2) throw new Error(`repositories entry must be host/owner/name or host/owner/*`);
  const [host, owner, name, ...extra] = segments;
  if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-z0-9-]+$/.test(owner)) {
    throw new Error(`repositories entry must be host/owner/name or host/owner/*`);
  }
  if (name === undefined) {
    // 'host/owner' alone is NOT the org pattern: only an explicit trailing '/*' is (§5.2). A bare
    // two-segment id is a malformed entry, and accepting it as a wildcard would silently broaden
    // the profile's credential scope to a whole owner.
    throw new Error(`repositories entry must be host/owner/name or host/owner/* (add the explicit /* for an owner-wide pattern)`);
  }
  // 'host/owner/*/private' is a malformed subpath, not an owner-wide pattern: the '*' is only the
  // owner-wide pattern when it is the LAST segment (Copilot review round 2 on #799).
  if (name === '*' && extra.length > 0) {
    throw new Error(`repositories entry must be host/owner/name or host/owner/* (a '*' only stands alone as the last segment)`);
  }
  if (name === '*') return `${host}/${owner}/*`;
  if (extra.length > 0 || !/^[a-z0-9._-]+$/.test(name)) {
    throw new Error(`repositories entry must be host/owner/name or host/owner/*`);
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
  // Null-prototype dictionary: Object.entries on a plain object only sees OWN keys so inherited
  // names like 'toString' cannot pass the httpsToken cross-check, and a '__proto__' entry from the
  // file becomes an ordinary key instead of mutating Object.prototype.
  const rawEnv: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries((raw.env ?? {}) as Record<string, unknown>)) {
    // defineProperty, not assignment: '__proto__' from JSON.parse is an own key of the parsed
    // object, but plain assignment onto a null-proto target would still be fine - using
    // defineProperty keeps the copy explicit and setter-free either way.
    Object.defineProperty(rawEnv, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  const env: Record<string, ProfileEnvValue> = Object.create(null);
  for (const [key, value] of Object.entries(rawEnv)) {
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
      if (typeof g.httpsToken !== 'string' || g.httpsToken === '') {
        throw new Error(`${where2}: git.httpsToken must be a non-empty string naming an env entry`);
      }
      // The value is whatever the file author put there - sometimes a pasted secret instead of a
      // NAME. Never echo it (§5.1: values never appear in errors or output).
      if (!Object.prototype.hasOwnProperty.call(env, g.httpsToken)) {
        throw new Error(`${where2}: git.httpsToken does not name an entry in this profile's env (available: ${Object.keys(env).join(', ') || 'none'})`);
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

// ---------------------------------------------------------------------------
// Resolution (CP-3, issue #807; design §5.3)
// ---------------------------------------------------------------------------

/** The four §5.3 outcomes for one Run. */
export type ProfileResolution =
  | { outcome: 'none' }
  | { outcome: 'profile'; name: string }
  | { outcome: 'refused'; reason: 'multiple-profiles' | 'owner-not-allowed'; profiles: string[]; message: string };

/**
 * Does this profile claim the id: an exact normalized match, or an owner-wide pattern
 * (`host/owner/*`, the only wildcard form §5.2 allows) whose prefix the id sits under.
 * Overlapping claims ACROSS profiles are refused at load, so a claimed id still maps to exactly
 * one profile.
 */
function profileClaims(profile: CredentialProfile, id: string): boolean {
  for (const repo of profile.repositories) {
    if (repo === id) return true;
    if (repo.endsWith('/*') && id.startsWith(repo.slice(0, -1)) && !id.endsWith('/*')) return true;
  }
  return false;
}

/**
 * Which profile a Run uses, per design §5.3. `repositories` holds the Run's primary repository
 * plus every entry of `repositories[]`; entries with no `url` (localPath-only, or empty) have no
 * id and match nothing, so a Run can carry a public dependency checkout alongside a claimed repo.
 *
 * A `url` that does not normalize (malformed shape, or a redaction that replaced part of it) has
 * no id and matches nothing — the same answer as pre-CP-3 — rather than refusing a Run that
 * created fine before profiles existed. With no profile file loaded this function is never
 * called — a host without profiles behaves exactly as before CP-3.
 *
 * The owner is compared case-insensitively (GitHub logins are case-insensitive; repository ids
 * are already lowercased by normalizeRepositoryId). Profile `owners` are stored as written.
 */
export function resolveProfile(
  profiles: ReadonlyArray<CredentialProfile>,
  ownerId: string,
  repositories: ReadonlyArray<{ url?: string; localPath?: string }>,
): ProfileResolution {
  if (profiles.length === 0) return { outcome: 'none' };
  // The matched ids, kept for the owner-not-allowed message (normalizeRepositoryId redacts
  // userinfo before an id can reach any message — never-print-values, §9).
  const matched = new Map<string, string>(); // profile name -> one redacted id that matched it
  for (const repo of repositories) {
    if (typeof repo.url !== 'string' || repo.url.trim() === '') continue; // no id, matches nothing
    // An id that does not normalize (a redacted or malformed URL, a scheme shape the §5.2 table
    // does not know) has NO id: it matches nothing and is skipped. Both sides of the parity
    // check (creation and claim) resolve the SAME stored bytes, so a skipped id is skipped
    // identically on both sides — refusing here instead would turn a Run that pre-CP-3 created
    // fine into a 500 whenever any profile exists, even on an unrelated repository.
    let id: string;
    try {
      id = normalizeRepositoryId(repo.url);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      if (!profileClaims(profile, id)) continue;
      // Overlapping patterns were refused at load (§5.2/§9), so an id can only ever match ONE
      // profile; the first sighting names the refusal. The other ids are still inspected so a
      // Run matching two DIFFERENT profiles reports the broader multiple-profiles refusal.
      if (!matched.has(profile.name)) matched.set(profile.name, id);
    }
  }
  if (matched.size === 0) return { outcome: 'none' };
  if (matched.size > 1) {
    const names = [...matched.keys()].sort();
    return {
      outcome: 'refused',
      reason: 'multiple-profiles',
      profiles: names,
      message: `the Run's repositories match two different credential profiles (${names.map((n) => `'${n}'`).join(' and ')}); one Run, one identity`,
    };
  }
  const [name] = matched.keys();
  const profile = profiles.find((p) => p.name === name)!;
  const owner = profile.owners.find((o) => o.toLowerCase() === ownerId.toLowerCase());
  if (owner === undefined) {
    const id = matched.get(name)!;
    return {
      outcome: 'refused',
      reason: 'owner-not-allowed',
      profiles: [name],
      message: `credential profile '${name}' does not allow owner '${ownerId}' (repository ${id} is claimed by that profile)`,
    };
  }
  return { outcome: 'profile', name };
}
