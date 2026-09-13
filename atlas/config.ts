/**
 * Atlas configuration. Atlas is a knowledge base service that holds curated notes and must never
 * import from Mercury's src/ or Fleet's code, so everything Atlas needs is parsed here
 * from its own environment. Node builtins and declared dependencies only.
 */

export interface AtlasConfig {
  /** Atlas's own SQLite database. */
  dbPath: string;
  /** Address the service binds. Loopback by default, matching Mercury's own safe default. */
  bindHost: string;
  port: number;
  /** TLS. Required before binding beyond loopback, because reader tokens would cross the LAN in plaintext. */
  tlsCert: string | null;
  tlsKey: string | null;
  /** Optional admin token for management operations. */
  adminToken: string | null;
  /** Path to the contributors file, expanded from ~. */
  contributorsFile: string;
  /**
   * Reader tokens: `token:label:project1+project2`, comma-separated.
   * Parsed into {token, label, projects: string[]}[].
   * Malformed entries are skipped, not fatal.
   */
  readerTokens: { token: string; label: string; projects: string[] }[];
  /** Comma-separated list of secrets to seed the redactor. Empties are dropped. */
  secrets: string[];
  /** Maximum size in bytes for a claim. */
  maxClaimBytes: number;
  /** Maximum size in bytes for a detail. */
  maxDetailBytes: number;
  /** Maximum number of items in a batch request. */
  maxBatch: number;
  /** Log level. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Reject NaN, negatives and zero explicitly: a zero interval would spin the event loop hot.
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Parse a TCP port. Unlike an interval or a timeout, 0 is meaningful here -- it asks the OS for an
 * ephemeral port -- so it must not fall back the way `num` does. Silently turning 0 into 4100 made every
 * test instance fight over one fixed port.
 */
function port(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

/**
 * Default contributors location, outside the working tree so it cannot be committed by accident.
 *
 * Takes the environment as a parameter rather than reading `process.env` inside: `loadAtlasConfig`
 * is called with a synthetic environment by every test that touches this setting, and a helper that
 * reached around its own caller would make those tests depend on the HOME of whoever ran them.
 */
function defaultContributorsFile(env: Record<string, string | undefined>): string {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
  return home.replace(/\/+$/, '') + '/.atlas/contributors.json';
}

/** Parse reader tokens: token:label:project1+project2. Malformed entries are skipped. */
function parseReaderTokens(raw: string | undefined): { token: string; label: string; projects: string[] }[] {
  if (!raw || raw.trim() === '') return [];
  const result: { token: string; label: string; projects: string[] }[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length < 3) continue; // Skip malformed
    const token = parts[0]?.trim();
    const label = parts[1]?.trim();
    const projectsStr = parts[2]?.trim();
    if (!token || !label || !projectsStr) continue;
    const projects = projectsStr.split('+').map((p) => p.trim()).filter(Boolean);
    if (!projects.length) continue;
    result.push({ token, label, projects });
  }
  return result;
}

/** Parse secrets: comma-separated, trimmed, empties dropped. */
function parseSecrets(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadAtlasConfig(env: Record<string, string | undefined> = process.env): AtlasConfig {
  const bindHost = env['ATLAS_BIND_HOST'] ?? '127.0.0.1';
  const tlsCert = env['ATLAS_TLS_CERT'] || null;
  const tlsKey = env['ATLAS_TLS_KEY'] || null;

  const config: AtlasConfig = {
    dbPath: env['ATLAS_DB'] ?? 'atlas.db',
    bindHost,
    port: port(env['ATLAS_PORT'], 4100),
    tlsCert,
    tlsKey,
    adminToken: env['ATLAS_ADMIN_TOKEN'] || null,
    contributorsFile: env['ATLAS_CONTRIBUTORS_FILE'] ?? defaultContributorsFile(env),
    readerTokens: parseReaderTokens(env['ATLAS_READER_TOKENS']),
    secrets: parseSecrets(env['ATLAS_SECRETS']),
    maxClaimBytes: num(env['ATLAS_MAX_CLAIM_BYTES'], 1024),
    maxDetailBytes: num(env['ATLAS_MAX_DETAIL_BYTES'], 4096),
    maxBatch: num(env['ATLAS_MAX_BATCH'], 500),
    logLevel: level(env['ATLAS_LOG_LEVEL']),
  };

  assertServeable(config);
  return config;
}

function level(raw: string | undefined): AtlasConfig['logLevel'] {
  const v = (raw ?? 'info').toLowerCase();
  return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
}

/** True when `host` is a loopback address, so TLS may be omitted. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Refuse to start in a configuration that would leak reader credentials.
 *
 * Binding beyond loopback without TLS puts every reader's bearer token on the wire in plaintext. Atlas
 * holds every project's curated knowledge, so a leaked reader token reaches claims every Mercury in the
 * organization should trust. The safe default is to fail at startup with an explanation rather than serve
 * insecurely and leave discovery to an audit.
 */
export function assertServeable(config: AtlasConfig): void {
  // Half a TLS configuration is checked first: telling someone to "set ATLAS_TLS_CERT and ATLAS_TLS_KEY"
  // when they set exactly one of them is a message that cannot be acted on.
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) {
    throw new Error('ATLAS_TLS_CERT and ATLAS_TLS_KEY must both be set or both unset');
  }
  const tls = Boolean(config.tlsCert && config.tlsKey);
  if (!isLoopback(config.bindHost) && !tls) {
    throw new Error(
      `refusing to bind ${config.bindHost}:${config.port} without TLS. Reader bearer tokens would cross ` +
        `the network in plaintext, and Atlas holds every project's curated knowledge. Set ATLAS_TLS_CERT ` +
        `and ATLAS_TLS_KEY, or bind 127.0.0.1 and terminate TLS in a reverse proxy.`,
    );
  }
}
