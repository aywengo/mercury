// `config profiles` and `config current` (§9, §16 Milestone 4).
//
// These exist because configuration here comes from three layers -- flags, environment, and a profile
// file -- and the operator's question when something is wrong is always "which one won?". The answers
// come from describeConfig, the same function the request path resolves through, so this command cannot
// tell a different story from the code that actually builds the request.
//
// Neither command makes a network request, and neither needs a credential. They are dispatched before
// the client is built for exactly that reason: an operator whose token is wrong still has to be able to
// ask what the client thinks its configuration is.

import { configPath, describeConfig, readConfigFile, type ConfigSource, type ResolvedConfigDetail } from '../config.ts';
import { configDir } from '../credentials.ts';
import { resolveCredential } from '../credentials.ts';
import { makeColorizer, sanitizeForTerminal } from '../output/human.ts';
import { eventLine } from '../output/json.ts';

export interface RenderOptions {
  json: boolean;
  noColor: boolean;
  isTty: boolean;
}

export interface ProfileRow {
  name: string;
  url: string | null;
  credential: string | null;
  timeoutMs: number | null;
  caFile: string | null;
  current: boolean;
}

/**
 * One row per profile in the file, with the URL each would use.
 *
 * Each profile is resolved on its own and a profile that fails to resolve is reported with its error
 * rather than aborting the listing. A file with one stale profile out of five is the normal state of a
 * real configuration, and `config profiles` is the command an operator uses to find the stale one.
 */
/**
 * List the profiles in the config file WITHOUT resolving a configuration first.
 *
 * `config profiles` answers "what is in my file?", which is answerable with no endpoint, no credential
 * and no network. Routing it through the full resolver made it fail with "no endpoint configured" on a
 * machine that had a perfectly readable file -- the command an operator runs to diagnose a missing
 * endpoint was itself refusing to run without one.
 */
export interface ProfilesListing {
  configFilePath: string;
  configFilePresent: boolean;
  currentProfile: string;
  rows: Array<ProfileRow & { error: string | null }>;
}

export function listProfiles(options: {
  profileFlag?: string;
  env?: NodeJS.ProcessEnv;
  dir?: string;
} = {}): ProfilesListing {
  const env = options.env ?? process.env;
  const dir = options.dir ?? configDir(env);
  const path = configPath(dir);
  const file = readConfigFile(path);
  const names = Object.keys(file?.profiles ?? {});
  const currentProfile =
    options.profileFlag ?? env.MERCURY_CLIENT_PROFILE?.trim() ?? file?.currentProfile ?? 'default';
  const rows: Array<ProfileRow & { error: string | null }> = names.map((name) => {
    const base: ProfileRow & { error: string | null } = {
      name, url: null, credential: null, timeoutMs: null, caFile: null, current: name === currentProfile, error: null,
    };
    try {
      // Resolve the profile the way a request would, rather than reading the file and re-deriving the
      // rules: normalisation, defaults and validation all come from the same code a real call uses.
      const one = describeConfig({ ...options, profileFlag: name, urlFlag: undefined, timeoutFlagMs: undefined, env });
      return {
        ...base,
        url: one.config.url,
        credential: one.config.credentialName ?? null,
        timeoutMs: one.config.timeoutMs,
        caFile: one.config.caFile ?? null,
      };
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }
  });
  return { configFilePath: path, configFilePresent: file !== undefined, currentProfile, rows };
}

export function collectProfiles(
  detail: ResolvedConfigDetail,
  options: { profileFlag?: string; urlFlag?: string; timeoutFlagMs?: number; noColorFlag?: boolean; env?: NodeJS.ProcessEnv; dir?: string },
): Array<ProfileRow & { error: string | null }> {
  const env = options.env ?? process.env;
  return detail.profiles.map((name) => {
    const base: ProfileRow & { error: string | null } = {
      name, url: null, credential: null, timeoutMs: null, caFile: null,
      current: name === detail.config.profileName, error: null,
    };
    try {
      // Resolve the profile the way a request would: as a profile flag, so precedence matches reality
      // instead of reading the file and guessing at the rules.
      const one = describeConfig({ ...options, profileFlag: name, urlFlag: undefined, timeoutFlagMs: undefined });
      return {
        ...base,
        url: one.config.url,
        credential: one.config.credentialName ?? null,
        timeoutMs: one.config.timeoutMs,
        caFile: one.config.caFile ?? null,
      };
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }
  });
}

export function renderProfiles(listing: ProfilesListing, ctx: RenderOptions): string {
  if (ctx.json) return eventLine({
    configFile: listing.configFilePath,
    configFilePresent: listing.configFilePresent,
    currentProfile: listing.currentProfile,
    profiles: listing.rows,
  }).replace(/\n$/, '');
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty: ctx.isTty, json: false });
  if (listing.rows.length === 0) {
    return listing.configFilePresent
      ? color('dim', `no profiles defined in ${listing.configFilePath}`)
      : `${color('dim', `no config file at ${listing.configFilePath}`)}\n` +
        'configuration is coming from flags or the environment; run `config current` to see it.';
  }
  const rows = listing.rows;
  return rows.map((row) => {
    const marker = row.current ? color('cyan', '*') : ' ';
    const name = sanitizeForTerminal(row.name).padEnd(18);
    if (row.error) return `${marker} ${name} ${color('red', sanitizeForTerminal(row.error))}`;
    const bits = [
      sanitizeForTerminal(row.url ?? ''),
      row.credential ? `credential=${sanitizeForTerminal(row.credential)}` : '',
      row.caFile ? `ca=${sanitizeForTerminal(row.caFile)}` : '',
    ].filter(Boolean).join('  ');
    return `${marker} ${name} ${color('dim', bits)}`.trimEnd();
  }).join('\n');
}

export interface CurrentView {
  profileName: string;
  url: string;
  credential: string | null;
  credentialOrigin: string | null;
  timeoutMs: number;
  caFile: string | null;
  noColor: boolean;
  configFile: string;
  configFilePresent: boolean;
  sources: Record<string, ConfigSource>;
}

/**
 * The resolved configuration, with the layer each value came from.
 *
 * `credential` is a NAME and `credentialOrigin` is `env`, `file`, or `null`. Neither field can hold a
 * token: the resolved value is read only to decide whether one exists, then dropped. A command whose
 * entire purpose is printing configuration is exactly where a leak would get copy-pasted into a bug
 * report, so the value never enters this object.
 */
export function buildCurrentView(
  detail: ResolvedConfigDetail,
  env: NodeJS.ProcessEnv = process.env,
  dir?: string,
): CurrentView {
  const cfg = detail.config;
  let credentialOrigin: string | null = null;
  try {
    credentialOrigin = resolveCredential({ credentialName: cfg.credentialName, env, dir }).origin;
  } catch {
    // Absent or unusable is a state worth reporting, not an error here. `config current` is what an
    // operator reaches for when nothing works; refusing to answer would hide the reason.
    credentialOrigin = null;
  }
  return {
    profileName: cfg.profileName,
    url: cfg.url,
    credential: cfg.credentialName ?? null,
    credentialOrigin,
    timeoutMs: cfg.timeoutMs,
    caFile: cfg.caFile ?? null,
    noColor: cfg.noColor,
    configFile: detail.configFilePath,
    configFilePresent: !detail.noConfigFile,
    sources: detail.sources as Record<string, ConfigSource>,
  };
}

export function renderCurrent(view: CurrentView, ctx: RenderOptions): string {
  if (ctx.json) return eventLine(view).replace(/\n$/, '');
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty: ctx.isTty, json: false });
  const src = (key: string): string => {
    const s = (view.sources as Record<string, ConfigSource>)[key];
    return s ? color('dim', `  (${s})`) : '';
  };
  const rows: Array<[string, string, string]> = [
    ['profile', sanitizeForTerminal(view.profileName), src('profileName')],
    ['url', sanitizeForTerminal(view.url), src('url')],
    [
      'credential',
      view.credential ? sanitizeForTerminal(view.credential) : color('yellow', 'not set'),
      view.credentialOrigin ? color('dim', `  (resolved from ${view.credentialOrigin})`) : color('dim', '  (no usable credential)'),
    ],
    ['timeout', `${view.timeoutMs}ms`, src('timeoutMs')],
    ['caFile', view.caFile ? sanitizeForTerminal(view.caFile) : color('dim', 'system trust store'), src('caFile')],
    ['color', view.noColor ? 'off' : 'on', src('noColor')],
    ['config file', view.configFilePresent ? sanitizeForTerminal(view.configFile) : color('dim', 'none'), ''],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v, s]) => `${color('dim', k.padEnd(width))}  ${v}${s}`.trimEnd()).join('\n');
}
