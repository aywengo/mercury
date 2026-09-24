// Environment configuration (all optional, sensible defaults).

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_BOUNDS, type KnowledgeBounds } from './knowledge/validation.ts';

export interface Config {
  dbPath: string;
  port: number;
  /**
   * Host harness allowlist (MERCURY_HARNESSES, comma-separated). Gates which of the
   * three shipped host harnesses (primeagent, hermes, claude) get an adapter registered;
   * unset = every shipped harness. `fake` and the declarative local/remote/rpc agents are
   * not host harnesses and are never filtered (docs/host-installer.md M3, issue #645).
   */
  harnesses: string[] | null;
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
  /**
   * Path to the same-host worker->API wake-up socket (MERCURY_EVENT_WAKEUP_SOCKET).
   *
   * UNSET BY DEFAULT, and unset means the feature does not exist: no socket is created, no listener is
   * started, and event delivery is byte-identical to Stage 0 polling. That is deliberate (section 14
   * step 2) -- the measurement in section 14.1 bounds poll lag at one fast interval already, so this is
   * an opt-in latency improvement and not a correctness dependency. Polling never stops running.
   */
  eventWakeupSocket: string | null;
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
  /** Deadline for local git plumbing (rev-parse, worktree add/remove, branch -D). */
  gitTimeoutMs: number;
  /** Deadline for git clone/fetch. A large repository legitimately takes minutes. */
  gitNetworkTimeoutMs: number;
  workspaceQuotaBytes: number;
  gcIntervalMs: number;
  /** Queue backlog depth that triggers an alert (MERCURY_BACKLOG_ALERT_THRESHOLD). */
  backlogAlertThreshold: number;
  backlogCheckIntervalMs: number;
  /** Optional webhook URL for backlog alerts (MERCURY_ALERT_WEBHOOK_URL); null disables. */
  alertWebhookUrl: string | null;
  /**
   * Agent id used when a create request omits `agent` (MERCURY_DEFAULT_AGENT).
   * Default `fake` so a first Run does not spawn a coding-agent CLI.
   */
  defaultAgent: string;
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
  /**
   * Knowledge base (docs/knowledge-base.md sections 7.5 and 8.4). Null when Atlas is not
   * configured, which is the whole feature being off: no tables read, no timers started, no
   * events emitted, and `POST /api/runs` rejects a `knowledge` block with 400.
   */
  knowledge: KnowledgeConfig;
}

/** Where this host's notes go, and how it authenticates (section 8.4). */
export interface AtlasConfig {
  url: string;
  token: string;
  project: string;
  /** Provenance id recorded on every note. Defaults to the hostname. */
  hostId: string;
  caFile: string | null;
  /**
   * A token able to POST `source: operator` notes. Optional, and separate from `token` on purpose.
   *
   * Section 11.1 makes an operator note an ADMIN act, because it lands promoted and skipping curation is
   * exactly what a contributor token must never be able to do. Section 11.4 makes the host's everyday
   * token a CONTRIBUTOR for the mirror-image reason. So the durable outbox, which drains with the
   * contributor token, structurally cannot deliver an operator note -- and the alternative, letting the
   * host's everyday credential promote notes, would undo the split those two sections exist to create.
   *
   * Absent means operator notes are refused at the door rather than queued where they can never leave.
   */
  adminToken: string | null;
}

/**
 * Knowledge settings. `atlas === null` is the only disabled state; everything below it is read
 * only when Atlas is configured.
 */
export interface KnowledgeConfig {
  atlas: AtlasConfig | null;
  /** Whether Runs receive a pack by default (MERCURY_KNOWLEDGE_INJECT). */
  inject: boolean;
  packMaxBytes: number;
  pushIntervalMs: number;
  pushBatch: number;
  pullIntervalMs: number;
  /**
   * How long to retain non-promoted rows in the replica before the puller sweeps them (ms).
   * 7 days (604_800_000) by default -- see docs/knowledge-base.md §8.3 for the reasoning.
   */
  retiredRetentionMs: number;
  /** Outbox depth that triggers an alert, in the style of `backlogAlertThreshold`. */
  outboxAlertDepth: number;
  bounds: KnowledgeBounds;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Parse MERCURY_API_TOKENS: `token:owner` pairs, comma-separated. The split is strict — an
 * entry with more or fewer than exactly one `:` refuses the whole load (#729): the silent
 * `tok-a:bot:maint -> owner "bot"` truncation made every misconfigured bot share one owner
 * scope, and a truncated authorization mapping must never parse as something smaller. The
 * error names the entry's 0-based position, never the token itself, so the message is safe
 * for logs. Bot owner ids use the colon-free form `bot-<alias>` (docs/dispatcher-bot-design.md §4.2).
 */
function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  const entries = raw.split(',');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!.trim();
    if (entry === '') continue;
    const parts = entry.split(':');
    if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
      // Name the actual defect, not a guess: an entry can be malformed by SHAPE (wrong number of
      // colons) or by CONTENT (one side empty). 'tok-alice:' has exactly one colon, so an
      // "extra colon segments" phrasing would send the operator hunting for a second colon that
      // does not exist. The token itself is never echoed (it is a credential).
      const colons = (entry.match(/:/g) ?? []).length;
      const shape = colons === 0
        ? 'no colon separating token from owner'
        : colons === 1
          ? (parts[0]!.trim() ? 'empty owner half' : 'empty token half')
          : `${colons} colons (expected exactly one colon)`;
      throw new Error(
        `MERCURY_API_TOKENS entry ${i} must be exactly 'token:owner'; got an entry with ${shape}`,
      );
    }
    map.set(parts[0]!.trim(), parts[1]!.trim());
  }
  return map;
}

/** Parse a numeric env var; fall back to `fallback` when unset or not a finite number. */
function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The harness ids that name a SHIPPED host harness (the adapters a host machine runs
 * CLI binaries for, docs/host-installer.md). `fake` is a test/dev adapter and the
 * declarative local/remote/rpc registries are fleet-defined agents; neither is a host
 * harness, so the allowlist never filters them.
 */
export const HOST_HARNESSES = ['primeagent', 'hermes', 'claude'] as const;

/** Parse MERCURY_HARNESSES: unset/empty = null (every shipped harness enabled). */
export function parseHarnesses(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const ids = raw.split(',').map((v) => v.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const unknown = ids.filter((id) => !(HOST_HARNESSES as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(`MERCURY_HARNESSES: unknown harness '${unknown[0]}'; known: ${HOST_HARNESSES.join(', ')}`);
  }
  return ids;
}

/**
 * Apply the MERCURY_HARNESSES allowlist to an adapter registry (issue #645: the wizard
 * wrote it, nothing read it). A shipped harness NOT in the list loses its adapter, so a
 * disabled harness cannot run; everything else (fake, declarative agents) passes through.
 * `null` list = no gate. Returns a new map; the input is not mutated.
 */
export function applyHarnessGate<T extends Record<string, unknown>>(
  adapters: T,
  harnesses: string[] | null,
): T {
  if (harnesses === null) return adapters;
  const allowed = new Set(harnesses);
  const out: Record<string, unknown> = {};
  for (const [id, adapter] of Object.entries(adapters)) {
    if (!(HOST_HARNESSES as readonly string[]).includes(id) || allowed.has(id)) out[id] = adapter;
  }
  return out as T;
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
    // Absolute at load (issue #703): git resolves a relative `worktree add` target against the
    // clone directory (-C repoDir), while every Node-side consumer resolves the same string
    // against the process cwd -- two directories answering to one path. The shipped default
    // './workspaces' is exactly that shape, so resolve here, once, before anything consumes it.
    workspaceBase: resolve(env.MERCURY_WORKSPACE_BASE ?? './workspaces'),
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
    eventWakeupSocket: env.MERCURY_EVENT_WAKEUP_SOCKET ?? null,
    maxRetries: num(env.MERCURY_MAX_RETRIES, 2),
    retryBackoffMs: num(env.MERCURY_RETRY_BACKOFF_MS, 5_000),
    inputPollMs: num(env.MERCURY_INPUT_POLL_MS, 200),
    inputTimeoutMs: num(env.MERCURY_INPUT_TIMEOUT_MS, 30 * 60 * 1000),
    stuckRunThresholdMs: num(env.MERCURY_STUCK_RUN_THRESHOLD_MS, 30 * 60 * 1000),
    stuckCheckIntervalMs: num(env.MERCURY_STUCK_CHECK_INTERVAL_MS, 60_000),
    workspaceRetentionMs: num(env.MERCURY_WORKSPACE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
    gitTimeoutMs: num(env.MERCURY_GIT_TIMEOUT_MS, 30_000),
    gitNetworkTimeoutMs: num(env.MERCURY_GIT_NETWORK_TIMEOUT_MS, 600_000),
    workspaceQuotaBytes: num(env.MERCURY_WORKSPACE_QUOTA_BYTES, 10 * 1024 * 1024 * 1024),
    gcIntervalMs: num(env.MERCURY_GC_INTERVAL_MS, 60 * 60 * 1000),
    backlogAlertThreshold: num(env.MERCURY_BACKLOG_ALERT_THRESHOLD, 10),
    backlogCheckIntervalMs: num(env.MERCURY_BACKLOG_CHECK_INTERVAL_MS, 60_000),
    alertWebhookUrl: env.MERCURY_ALERT_WEBHOOK_URL ?? null,
    defaultAgent: env.MERCURY_DEFAULT_AGENT?.trim() || 'fake',
    harnesses: parseHarnesses(env.MERCURY_HARNESSES),
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
    knowledge: loadKnowledgeConfig(env),
  };
}

/**
 * Knowledge configuration (docs/knowledge-base.md sections 7.5 and 8.4).
 *
 * Unset `MERCURY_ATLAS_URL` means the feature does not exist, and that is the one disabled state.
 * It is checked first and returns immediately so no other knowledge variable can half-enable
 * anything: an outbox that fills with nobody draining it, or a puller that polls nothing, are both
 * worse than absence because they look like activity.
 *
 * A URL *without* a token or a project throws rather than disabling. That is the opposite of how
 * `trustProxy` and the numeric knobs behave, deliberately: those coerce a typo toward the safe
 * value, whereas this pairing decides **which project a note lands in** (section 5), and silently
 * running without knowledge is how a documented setting ends up unread. This repository has already
 * paid for a documented config example that the loader quietly skipped -- issue #505 -- and a
 * misconfigured Atlas URL that degrades to "no knowledge" is the same failure with a longer fuse.
 * Failing at boot is loud, costs nothing, and names the missing variable.
 */
export function loadKnowledgeConfig(env: NodeJS.ProcessEnv): KnowledgeConfig {
  const url = env.MERCURY_ATLAS_URL?.trim();
  if (!url) {
    return {
      atlas: null,
      inject: env.MERCURY_KNOWLEDGE_INJECT !== 'false',
      packMaxBytes: num(env.MERCURY_KNOWLEDGE_PACK_MAX_BYTES, 32_768),
      pushIntervalMs: num(env.MERCURY_KNOWLEDGE_PUSH_INTERVAL_MS, 30_000),
      pushBatch: num(env.MERCURY_KNOWLEDGE_PUSH_BATCH, 100),
      pullIntervalMs: num(env.MERCURY_KNOWLEDGE_PULL_INTERVAL_MS, 60_000),
      // 7 days: long enough for any operational investigation cycle, and orders of magnitude longer
      // than the pull interval, so the cursor has advanced past any in-flight page before a swept
      // row could be replayed. See docs/knowledge-base.md §8.3 for the full reasoning.
      retiredRetentionMs: num(env.MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS, 604_800_000),
      outboxAlertDepth: num(env.MERCURY_KNOWLEDGE_OUTBOX_ALERT_DEPTH, 1000),
      bounds: knowledgeBounds(env),
    };
  }
  const missing: string[] = [];
  if (!env.MERCURY_ATLAS_TOKEN?.trim()) missing.push('MERCURY_ATLAS_TOKEN');
  if (!env.MERCURY_ATLAS_PROJECT?.trim()) missing.push('MERCURY_ATLAS_PROJECT');
  if (missing.length > 0) {
    throw new Error(
      `MERCURY_ATLAS_URL is set but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not. `
      + 'A host contributes to exactly one project, so a half-configured Atlas would either drop notes '
      + 'on the floor or send them somewhere unspecified. Unset MERCURY_ATLAS_URL to disable the '
      + 'feature entirely.',
    );
  }
  return {
    atlas: {
      url: url.replace(/\/+$/, ''),
      token: env.MERCURY_ATLAS_TOKEN!.trim(),
      project: env.MERCURY_ATLAS_PROJECT!.trim(),
      hostId: env.MERCURY_ATLAS_HOST_ID?.trim() || hostname(),
      // `|| null` rather than `??`: compose interpolation and dotenv both produce an EMPTY
      // string for a variable that is set-but-blank, and readFileSync('') is a confusing
      // error. Trimmed first, so a whitespace-only value is blank the same way a blank
      // MERCURY_ATLAS_URL is: blank means unset, exactly as for the URL above.
      caFile: env.MERCURY_ATLAS_CA_FILE?.trim() || null,
      // Deliberately NOT in the `missing` check above. Every Run-side feature works without it; only
      // operator notes need it, and refusing to start over an optional token would disable a working
      // host. What refuses instead is the operator-note route, with a message naming this variable.
      adminToken: env.MERCURY_ATLAS_ADMIN_TOKEN?.trim() || null,
    },
    inject: env.MERCURY_KNOWLEDGE_INJECT !== 'false',
    packMaxBytes: num(env.MERCURY_KNOWLEDGE_PACK_MAX_BYTES, 32_768),
    pushIntervalMs: num(env.MERCURY_KNOWLEDGE_PUSH_INTERVAL_MS, 30_000),
    pushBatch: num(env.MERCURY_KNOWLEDGE_PUSH_BATCH, 100),
    pullIntervalMs: num(env.MERCURY_KNOWLEDGE_PULL_INTERVAL_MS, 60_000),
    retiredRetentionMs: num(env.MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS, 604_800_000),
    outboxAlertDepth: num(env.MERCURY_KNOWLEDGE_OUTBOX_ALERT_DEPTH, 1000),
    bounds: knowledgeBounds(env),
  };
}

/** The ingest bounds of section 7.5. Tightening them is supported; loosening past Atlas's own
 *  server-side limits only means Atlas rejects what the host accepted, so the host stays honest. */
function knowledgeBounds(env: NodeJS.ProcessEnv): KnowledgeBounds {
  return {
    maxNotesPerRun: num(env.MERCURY_KNOWLEDGE_MAX_NOTES_PER_RUN, DEFAULT_BOUNDS.maxNotesPerRun),
    maxClaimBytes: num(env.MERCURY_KNOWLEDGE_MAX_CLAIM_BYTES, DEFAULT_BOUNDS.maxClaimBytes),
    maxDetailBytes: num(env.MERCURY_KNOWLEDGE_MAX_DETAIL_BYTES, DEFAULT_BOUNDS.maxDetailBytes),
    maxEvidence: num(env.MERCURY_KNOWLEDGE_MAX_EVIDENCE, DEFAULT_BOUNDS.maxEvidence),
    harvestTimeoutMs: num(env.MERCURY_KNOWLEDGE_HARVEST_TIMEOUT_MS, DEFAULT_BOUNDS.harvestTimeoutMs),
  };
}
