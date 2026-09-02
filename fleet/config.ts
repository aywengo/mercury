/**
 * Fleet configuration. Fleet is a federation layer over independent Mercury instances and must never
 * import from Mercury's src/ (docs/fleet-design.md section 11), so everything Fleet needs is parsed here
 * from its own environment. Node builtins and declared dependencies only.
 */

export interface FleetConfig {
  /** Fleet's own SQLite database. Separate from every Mercury database by design. */
  dbPath: string;
  /** Address the service binds. Loopback by default, matching Mercury's own safe default. */
  bindHost: string;
  port: number;
  /**
   * Caller tokens: `token:owner[:hosts]`, comma separated. Distinct from the child credentials in
   * `credentialsFile` -- a caller token is never forwarded to a child (design section 15.3).
   */
  apiTokens: string | undefined;
  adminToken: string | null;
  /** TLS. Required before binding beyond loopback, because caller tokens would cross the LAN in plaintext. */
  tlsCert: string | null;
  tlsKey: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Path to the JSON file mapping credential_ref -> secret. Referenced by name from the hosts table;
   * the secret itself is never stored in the database and never accepted as a command-line argument.
   */
  credentialsFile: string;
  /** How often the prober sweeps every enabled host. */
  probeIntervalMs: number;
  /** Per-request timeout for a single probe call. A hung host must not stall the sweep. */
  probeTimeoutMs: number;
  /**
   * How often reconciliation re-reads every non-terminal Run (design section 7). Independent of the probe
   * interval on purpose: probing asks "is this machine up" for every host, reconciling asks "what is this Run
   * doing" for every Run, and a fleet with three hosts and two hundred Runs wants those on different clocks.
   */
  sweepIntervalMs: number;
  /** How often an open SSE stream looks for newly mirrored events. */
  streamPollMs: number;
  /**
   * Optional JSON map of local path -> host-independent clone URL (design section 6's escape hatch). When a
   * submitted localPath is a key here, routing drops the locality constraint and sends the URL instead, which
   * turns the hardest routing rule into a non-issue for most work.
   */
  repoUrlsFile: string | null;
  /**
   * Escape hatch for filesystems where 0600 cannot be set. Off by default: a credential file readable by
   * the whole machine is the exact failure mode section 9 of the design exists to prevent.
   */
  allowInsecureCredentials: boolean;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Reject NaN, negatives and zero explicitly: a zero probe interval would spin the event loop hot.
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Parse a TCP port. Unlike an interval or a timeout, 0 is meaningful here -- it asks the OS for an
 * ephemeral port -- so it must not fall back the way `num` does. Silently turning 0 into 3100 made every
 * test instance fight over one fixed port.
 */
function port(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

/** Default credential location is outside the working tree so it cannot be committed by accident. */
function defaultCredentialsFile(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return home + '/.fleet/credentials.json';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): FleetConfig {
  return {
    dbPath: env['FLEET_DB'] ?? 'fleet.db',
    credentialsFile: env['FLEET_CREDENTIALS_FILE'] ?? defaultCredentialsFile(),
    probeIntervalMs: num(env['FLEET_PROBE_INTERVAL_MS'], 15_000),
    probeTimeoutMs: num(env['FLEET_PROBE_TIMEOUT_MS'], 5_000),
    sweepIntervalMs: num(env['FLEET_SWEEP_INTERVAL_MS'], 10_000),
    streamPollMs: num(env['FLEET_STREAM_POLL_MS'], 1000),
    repoUrlsFile: env.FLEET_REPO_URLS_FILE ?? null,
    allowInsecureCredentials: env['FLEET_ALLOW_INSECURE_CREDENTIALS'] === '1',
    bindHost: env['FLEET_BIND_HOST'] ?? '127.0.0.1',
    port: port(env['FLEET_PORT'], 3100),
    apiTokens: env['FLEET_API_TOKENS'],
    adminToken: env['FLEET_ADMIN_TOKEN'] || null,
    tlsCert: env['FLEET_TLS_CERT'] || null,
    tlsKey: env['FLEET_TLS_KEY'] || null,
    logLevel: level(env['FLEET_LOG_LEVEL']),
  };
}

function level(raw: string | undefined): FleetConfig['logLevel'] {
  const v = (raw ?? 'info').toLowerCase();
  return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Refuse to start in a configuration that would leak caller credentials.
 *
 * Binding beyond loopback without TLS puts every caller's bearer token on the wire in plaintext, and Fleet
 * tokens are the ones that reach a whole fleet. The safe default is to fail at startup with an explanation
 * rather than serve insecurely and leave discovery to an audit.
 */
export function assertServeable(config: FleetConfig): void {
  // Half a TLS configuration is checked first: telling someone to "set FLEET_TLS_CERT and FLEET_TLS_KEY"
  // when they set exactly one of them is a message that cannot be acted on.
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) {
    throw new Error('FLEET_TLS_CERT and FLEET_TLS_KEY must both be set or both unset');
  }
  const tls = Boolean(config.tlsCert && config.tlsKey);
  if (!LOOPBACK.has(config.bindHost) && !tls) {
    throw new Error(
      `refusing to bind ${config.bindHost}:${config.port} without TLS. Caller bearer tokens would cross ` +
        `the network in plaintext, and a Fleet token reaches every Mercury it manages. Set FLEET_TLS_CERT ` +
        `and FLEET_TLS_KEY, or bind 127.0.0.1 and terminate TLS in a reverse proxy.`,
    );
  }
  if (!config.apiTokens && !config.adminToken) {
    throw new Error(
      'no caller tokens configured: set FLEET_API_TOKENS (token:owner[:hosts]) or FLEET_ADMIN_TOKEN, ' +
        'otherwise every request would be rejected and the service would look broken.',
    );
  }
}
