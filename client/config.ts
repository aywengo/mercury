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
  // Reject a query OR a fragment on the base url. Both are silently dropped by url.origin below,
  // so a mistyped or copy-pasted endpoint would look like it worked while pointing somewhere else --
  // and "somewhere else" can be a different Mercury, which is how a create lands on the wrong host.
  if (url.search) throw new UsageError('endpoint URL must not include a query string');
  if (url.hash) throw new UsageError('endpoint URL must not include a fragment');
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
/** Where a resolved value came from. Reported by `config current` so an operator can see which of the
> three layers is winning, without reading the precedence rules out of the source. */
export type ConfigSource = 'flag' | 'env' | 'profile' | 'default';

export interface ResolvedConfigDetail {
  config: ResolvedConfig;
  /** Keyed by config field; only fields that were actually set appear. */
  sources: Partial<Record<keyof ResolvedConfig, ConfigSource>>;
  /** Profiles defined in the file, in file order. Empty when there is no config file. */
  profiles: string[];
  /** True when no config file exists at the resolved path. */
  noConfigFile: boolean;
  configFilePath: string;
}

/**
 * Resolve configuration and report how each value was chosen.
 *
 * `resolveConfig` is a projection of this, not a second implementation. Two copies of a precedence chain
 * is how a diagnostic command starts telling a different story from the code that actually makes the
 * request -- and `config current` is worth nothing if an operator cannot trust it to match behaviour.
 */
export function describeConfig(options: ResolveOptions = {}): ResolvedConfigDetail {
  const env = options.env ?? process.env;
  // configPath() appends config.json; passing options.dir straight through would hand a
  // directory to readFileSync and surface as EISDIR.
  const file = readConfigFile(options.dir ? configPath(options.dir) : undefined);

  const dir = options.dir ?? configDir();
  const detail: ResolvedConfigDetail = {
    config: undefined as never,
    sources: {},
    profiles: Object.keys(file?.profiles ?? {}),
    noConfigFile: file === undefined,
    configFilePath: configPath(dir),
  };

  // Blank means absent. `??` only skips null and undefined, so a declared-but-empty variable -- which
  // is what `${MERCURY_CLIENT_URL:-}` produces in a shell script, and what an unset CI variable often
  // becomes -- would win over a perfectly good profile and then fail with "no endpoint configured".
  // The message points at the wrong knob, because the knob that is broken is the one that is empty.
  const envUrl = nonEmpty(env.MERCURY_CLIENT_URL);
  const envProfile = nonEmpty(env.MERCURY_CLIENT_PROFILE);
  const profileName =
    options.profileFlag ?? envProfile ?? file?.currentProfile ?? 'default';
  if (options.profileFlag) detail.sources.profileName = 'flag';
  else if (envProfile) detail.sources.profileName = 'env';
  else if (file?.currentProfile) detail.sources.profileName = 'profile';
  else detail.sources.profileName = 'default';

  let profile: ProfileConfig | undefined;
  if (options.profileFlag || envProfile || file?.currentProfile) {
    profile = file?.profiles?.[profileName];
    if (!profile) {
      const known = Object.keys(file?.profiles ?? {});
      throw new UsageError(
        `profile ${JSON.stringify(profileName)} is not defined` +
        (known.length ? `; known profiles: ${known.join(', ')}` : '; no profiles are defined'),
      );
    }
  }

  const rawUrl = options.urlFlag ?? envUrl ?? profile?.url;
  if (options.urlFlag) detail.sources.url = 'flag';
  else if (envUrl) detail.sources.url = 'env';
  else if (profile?.url) detail.sources.url = 'profile';
  if (!rawUrl) {
    throw new UsageError(
      'no endpoint configured. Pass --url, set MERCURY_CLIENT_URL, or define a profile.',
    );
  }

  const timeoutEnvMs = parseTimeoutEnv(env.MERCURY_CLIENT_TIMEOUT_MS);
  const rawTimeout = options.timeoutFlagMs ?? timeoutEnvMs ?? profile?.timeoutMs;
  if (options.timeoutFlagMs !== undefined) detail.sources.timeoutMs = 'flag';
  else if (timeoutEnvMs !== undefined) detail.sources.timeoutMs = 'env';
  else if (profile?.timeoutMs !== undefined) detail.sources.timeoutMs = 'profile';
  else detail.sources.timeoutMs = 'default';
  if (rawTimeout !== undefined && (!Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
    throw new UsageError(`timeout must be a positive number of milliseconds, got ${JSON.stringify(rawTimeout)}`);
  }

  const noColor =
    options.noColorFlag ?? truthyEnv(env.MERCURY_CLIENT_NO_COLOR) ?? false;

  const caFile = profile?.caFile ?? undefined;
  if (caFile === null) throw new UsageError('profile caFile must be a path or absent, not null');

  const config: ResolvedConfig = {
    profileName,
    url: normalizeEndpoint(rawUrl),
    credentialName: profile?.credential,
    timeoutMs: rawTimeout ?? DEFAULT_TIMEOUT_MS,
    caFile,
    noColor,
  };
  if (config.credentialName) detail.sources.credentialName = 'profile';
  detail.sources.noColor = options.noColorFlag ? 'flag'
    : truthyEnv(env.MERCURY_CLIENT_NO_COLOR) ? 'env' : 'default';
  if (caFile) detail.sources.caFile = 'profile';
  detail.config = config;
  return detail;
}

/** Resolve configuration for a request. See `describeConfig` for the version that also reports sources. */
export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  return describeConfig(options).config;
}

/** A value that is present AND has content. Empty and whitespace-only are treated as unset. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function parseTimeoutEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`MERCURY_CLIENT_TIMEOUT_MS must be a number, got ${JSON.stringify(value)}`);
  return n;
}
