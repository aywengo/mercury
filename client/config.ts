// Profile, environment and flag resolution (docs/cli-tui-design.md §9).
//
// No network access happens here. Resolution is pure so it can be unit-tested, and so `--help` and
// usage errors work on a machine with no reachable server (§16 Milestone 0).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './api/errors.ts';
import { configDir } from './credentials.ts';

export interface ProfileConfig {
  url: string;
  /** Name of an entry in credentials.json. NEVER a token itself. */
  credential?: string;
  timeoutMs?: number;
  caFile?: string | null;
}

export interface ConfigFile {
  currentProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

export interface ResolvedConfig {
  profileName: string;
  url: string;
  credentialName?: string;
  timeoutMs: number;
  caFile?: string;
  noColor: boolean;
}

export interface ResolveOptions {
  profileFlag?: string;
  urlFlag?: string;
  timeoutFlagMs?: number;
  noColorFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  dir?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function configPath(dir = configDir()): string {
  return join(dir, 'config.json');
}

/**
 * Read the profile file. Absent is fine -- a single-endpoint user should be able to run the client
 * with only --url and MERCURY_CLIENT_TOKEN, which is the whole point of supporting environment
 * configuration. A file that EXISTS but does not parse is a hard error: silently falling back to
 * defaults would send requests to the wrong server, which is far worse than refusing to start.
 */
export function readConfigFile(path = configPath()): ConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new UsageError(`cannot read config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`config ${path} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const profiles = obj.profiles;
  if (profiles !== undefined && (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles))) {
    throw new UsageError(`config ${path}: profiles must be an object`);
  }
  return {
    currentProfile: typeof obj.currentProfile === 'string' ? obj.currentProfile : undefined,
    profiles: (profiles ?? {}) as Record<string, ProfileConfig>,
  };
}

/**
 * Validate an endpoint URL and enforce transport security.
 *
 * Plain HTTP is accepted only for loopback. Everything else must be HTTPS. There is no
 * skip-verification escape hatch anywhere in this client: the bearer token is sent on every request,
 * so a downgrade or a self-signed-but-untrusted cert is a credential theft, not an inconvenience.
 *
 * Returns the normalised base URL with no trailing slash, so callers can append paths without
 * producing double slashes.
 */
export function normalizeEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(`invalid endpoint URL ${JSON.stringify(rawUrl)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`endpoint scheme must be http or https, got ${JSON.stringify(url.protocol)}`);
  }
  if (url.username || url.password) {
    // Credentials in a URL would land in logs and shell history, and Mercury does not use them.
    throw new UsageError('endpoint URL must not contain userinfo; use a credential name or MERCURY_CLIENT_TOKEN');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UsageError(
      `refusing plain HTTP for non-loopback host ${JSON.stringify(url.hostname)}: the bearer token ` +
      'would cross the network in clear text. Use https://.',
    );
  }
  // Reject a query or fragment on the BASE url: it would be silently dropped when a path is
  // appended, so a mistyped endpoint would look like it worked.
  if (url.search) throw new UsageError('endpoint URL must not include a query string');
  const base = url.origin.replace(/\/$/, '');
  return base;
}

function truthyEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '' ) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new UsageError(`invalid boolean value ${JSON.stringify(value)}`);
}

/**
 * Resolve effective settings. Precedence, highest first (§9.2):
 *   flags > MERCURY_CLIENT_* environment > selected profile > defaults.
 *
 * The profile is selected by flag, then by MERCURY_CLIENT_PROFILE, then by currentProfile in the
 * file. Selecting a profile that does not exist is an error rather than a silent default: pointing
 * a create at the wrong Mercury is a costly mistake, and "it looked like it worked" is the failure
 * mode this whole file is written to avoid.
 */
export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  // configPath() appends config.json; passing options.dir straight through would hand a
  // directory to readFileSync and surface as EISDIR.
  const file = readConfigFile(options.dir ? configPath(options.dir) : undefined);

  const profileName =
    options.profileFlag ?? env.MERCURY_CLIENT_PROFILE ?? file?.currentProfile ?? 'default';

  let profile: ProfileConfig | undefined;
  if (options.profileFlag || env.MERCURY_CLIENT_PROFILE || file?.currentProfile) {
    profile = file?.profiles?.[profileName];
    if (!profile) {
      const known = Object.keys(file?.profiles ?? {});
      throw new UsageError(
        `profile ${JSON.stringify(profileName)} is not defined` +
        (known.length ? `; known profiles: ${known.join(', ')}` : '; no profiles are defined'),
      );
    }
  }

  const rawUrl = options.urlFlag ?? env.MERCURY_CLIENT_URL ?? profile?.url;
  if (!rawUrl) {
    throw new UsageError(
      'no endpoint configured. Pass --url, set MERCURY_CLIENT_URL, or define a profile.',
    );
  }

  const rawTimeout = options.timeoutFlagMs ?? parseTimeoutEnv(env.MERCURY_CLIENT_TIMEOUT_MS) ?? profile?.timeoutMs;
  if (rawTimeout !== undefined && (!Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
    throw new UsageError(`timeout must be a positive number of milliseconds, got ${JSON.stringify(rawTimeout)}`);
  }

  const noColor =
    options.noColorFlag ?? truthyEnv(env.MERCURY_CLIENT_NO_COLOR) ?? false;

  const caFile = profile?.caFile ?? undefined;
  if (caFile === null) throw new UsageError('profile caFile must be a path or absent, not null');

  return {
    profileName,
    url: normalizeEndpoint(rawUrl),
    credentialName: profile?.credential,
    timeoutMs: rawTimeout ?? DEFAULT_TIMEOUT_MS,
    caFile,
    noColor,
  };
}

function parseTimeoutEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`MERCURY_CLIENT_TIMEOUT_MS must be a number, got ${JSON.stringify(value)}`);
  return n;
}
