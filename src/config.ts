// Environment configuration (all optional, sensible defaults).

export interface Config {
  dbPath: string;
  port: number;
  /** Bind address for the API server (MERCURY_BIND_HOST); secure default 127.0.0.1. */
  bindHost: string;
  /** TLS cert/key file paths (MERCURY_TLS_CERT + MERCURY_TLS_KEY); null = plain http. */
  tls: { cert: string; key: string } | null;
  workspaceBase: string;
  workspaceMode: 'git-worktree' | 'copy';
  apiTokens: Map<string, string>; // token -> ownerId
  adminToken: string | null;
  secrets: string[];
  primeAgentCmd: string;
  primeAgentArgs: string[];
  embeddedWorker: boolean;
  leaseMs: number;
  /**
   * How long a SIGTERM'd worker waits (issue #51) for its in-flight run to terminate the
   * agent and requeue itself before closing the database anyway. Must stay well under
   * systemd's TimeoutStopSec so the reaper is only a backstop, never the normal path.
   */
  shutdownGraceMs: number;
  leaseHeartbeatMs: number;
  pollMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  inputPollMs: number;
  /** Max time a run may wait for human input (MERCURY_INPUT_TIMEOUT_MS); 0 = no limit. */
  inputTimeoutMs: number;
  /** Stuck-run alert threshold in ms (MERCURY_STUCK_RUN_THRESHOLD_MS); 0 = disabled. */
  stuckRunThresholdMs: number;
  /** Stuck-run check interval in ms (MERCURY_STUCK_CHECK_INTERVAL_MS). */
  stuckCheckIntervalMs: number;
  workspaceRetentionMs: number;
  workspaceQuotaBytes: number;
  gcIntervalMs: number;
  /** Queue backlog depth that triggers an alert (MERCURY_BACKLOG_ALERT_THRESHOLD). */
  backlogAlertThreshold: number;
  backlogCheckIntervalMs: number;
  /** Optional webhook URL for backlog alerts (MERCURY_ALERT_WEBHOOK_URL); null disables. */
  alertWebhookUrl: string | null;
  /** Agent execution mode: 'rpc' (default, subprocess per Run) or 'daemon' (resident sessions). */
  agentMode: 'rpc' | 'daemon';
  /** Container runtime for sandboxed execution (MERCURY_SANDBOX_RUNTIME: docker|podman|none). */
  sandboxRuntime: string | null;
  /** Container image for sandboxed execution (MERCURY_SANDBOX_IMAGE). */
  sandboxImage: string | null;
  /**
   * Environment variables forwarded into the sandbox container
   * (MERCURY_SANDBOX_ENV, comma-separated). Unset -> the built-in allowlist of model
   * provider keys. Set to empty -> forward nothing but PATH. Never a copy of the
   * worker's environment: the container runs untrusted agents.
   */
  sandboxEnv: string[] | null;
  /** Force `Secure` on the session cookie (MERCURY_COOKIE_SECURE=true). */
  cookieSecure: boolean;
  /**
   * Number of reverse-proxy hops to trust (MERCURY_TRUST_PROXY). Default 0 = trust NONE,
   * which is the only safe value when the API is exposed directly (issue #65).
   *
   * With 0, Express takes `req.ip` from the socket, so behind a proxy every client shares one
   * rate-limit bucket: legitimate users collectively exhaust the login budget and lock each
   * other out, while an attacker inside that shared bucket is barely throttled at all.
   *
   * Set to the number of proxies in front of the API (typically 1 for nginx/Caddy on the same
   * host, 2 for a CDN plus a local proxy). Express then derives `req.ip` from the right-hand
   * side of `X-Forwarded-For`, peeling exactly that many hops.
   *
   * Do NOT set this to `true`/"trust everything": that lets any client invent its own source IP
   * and walk straight around the per-IP limits. Depth is the safe form of this setting, which
   * is why it is a number and not a boolean. The accepted text is decimal digits only: `0x10`
   * and `1e3` parse as integers, and would otherwise mean 16 and 1000 trusted hops.
   */
  trustProxy: number;
  /**
   * Whether the host storage driver honours `--storage-opt size=`
   * (MERCURY_SANDBOX_DISK_LIMITS=true). Off by default because the common
   * overlay2-on-ext4 docker install rejects the flag outright.
   */
  sandboxDiskLimits: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [token, owner] = pair.split(':');
    if (token && owner) map.set(token.trim(), owner.trim());
  }
  return map;
}

/** Parse a numeric env var; fall back to `fallback` when unset or not a finite number. */
function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.MERCURY_WORKSPACE_MODE === 'copy' ? 'copy' : 'git-worktree';
  return {
    dbPath: env.MERCURY_DB ?? './mercury.db',
    port: num(env.MERCURY_PORT, 3000),
    // Secure default: loopback only. Set MERCURY_BIND_HOST=0.0.0.0 to expose
    // (then put it behind a TLS-terminating reverse proxy or MERCURY_TLS_*).
    bindHost: env.MERCURY_BIND_HOST ?? '127.0.0.1',
    tls: env.MERCURY_TLS_CERT && env.MERCURY_TLS_KEY
      ? { cert: env.MERCURY_TLS_CERT, key: env.MERCURY_TLS_KEY }
      : null,
    workspaceBase: env.MERCURY_WORKSPACE_BASE ?? './workspaces',
    workspaceMode: mode,
    apiTokens: parseTokens(env.MERCURY_API_TOKENS),
    adminToken: env.MERCURY_ADMIN_TOKEN ?? null,
    secrets: (env.MERCURY_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    primeAgentCmd: env.MERCURY_PRIMEAGENT_CMD ?? 'prime-agent',
    primeAgentArgs: parseArgs(env.MERCURY_PRIMEAGENT_ARGS),
    embeddedWorker: env.MERCURY_EMBEDDED_WORKER === 'true',
    leaseMs: num(env.MERCURY_LEASE_MS, 60_000),
    shutdownGraceMs: num(env.MERCURY_SHUTDOWN_GRACE_MS, 30_000),
    leaseHeartbeatMs: num(env.MERCURY_LEASE_HEARTBEAT_MS, 15_000),
    pollMs: num(env.MERCURY_POLL_MS, 250),
    maxRetries: num(env.MERCURY_MAX_RETRIES, 2),
    retryBackoffMs: num(env.MERCURY_RETRY_BACKOFF_MS, 5_000),
    inputPollMs: num(env.MERCURY_INPUT_POLL_MS, 200),
    inputTimeoutMs: num(env.MERCURY_INPUT_TIMEOUT_MS, 30 * 60 * 1000),
    stuckRunThresholdMs: num(env.MERCURY_STUCK_RUN_THRESHOLD_MS, 30 * 60 * 1000),
    stuckCheckIntervalMs: num(env.MERCURY_STUCK_CHECK_INTERVAL_MS, 60_000),
    workspaceRetentionMs: num(env.MERCURY_WORKSPACE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
    workspaceQuotaBytes: num(env.MERCURY_WORKSPACE_QUOTA_BYTES, 10 * 1024 * 1024 * 1024),
    gcIntervalMs: num(env.MERCURY_GC_INTERVAL_MS, 60 * 60 * 1000),
    backlogAlertThreshold: num(env.MERCURY_BACKLOG_ALERT_THRESHOLD, 10),
    backlogCheckIntervalMs: num(env.MERCURY_BACKLOG_CHECK_INTERVAL_MS, 60_000),
    alertWebhookUrl: env.MERCURY_ALERT_WEBHOOK_URL ?? null,
    agentMode: env.MERCURY_AGENT_MODE === 'daemon' ? 'daemon' : 'rpc',
    sandboxRuntime: env.MERCURY_SANDBOX_RUNTIME ?? null,
    sandboxImage: env.MERCURY_SANDBOX_IMAGE ?? null,
    sandboxEnv:
      env.MERCURY_SANDBOX_ENV === undefined
        ? null
        : env.MERCURY_SANDBOX_ENV.split(',').map((v) => v.trim()).filter(Boolean),
    sandboxDiskLimits: env.MERCURY_SANDBOX_DISK_LIMITS === 'true',
    cookieSecure: env.MERCURY_COOKIE_SECURE === 'true',
    // Non-numeric or negative input falls back to 0 (trust nothing) rather than throwing:
    // a typo in this knob must not take the API down at boot, and 0 is the safe direction.
    trustProxy: (() => {
      const raw = env.MERCURY_TRUST_PROXY?.trim();
      if (!raw) return 0;
      // Strict decimal digits only. Number() is far too permissive for this knob: it accepts
      // '0x10' (16) and '1e3' (1000), both of which are integers >= 0 and so would survive a
      // Number.isInteger check while silently trusting 16 or 1000 proxy hops -- the exact
      // over-trust this whole guard exists to prevent, arriving via a typo rather than intent.
      return /^\d+$/.test(raw) ? Number(raw) : 0;
    })(),
    logLevel: (env.MERCURY_LOG_LEVEL as Config['logLevel']) ?? 'info',
  };
}
