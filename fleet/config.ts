/**
 * Fleet configuration. Fleet is a federation layer over independent Mercury instances and must never
 * import from Mercury's src/ (docs/fleet-design.md section 11), so everything Fleet needs is parsed here
 * from its own environment. Node builtins and declared dependencies only.
 */

export interface FleetConfig {
  /** Fleet's own SQLite database. Separate from every Mercury database by design. */
  dbPath: string;
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
    allowInsecureCredentials: env['FLEET_ALLOW_INSECURE_CREDENTIALS'] === '1',
  };
}
