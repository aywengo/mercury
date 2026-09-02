/**
 * Pure protocol logic for the PrimeAgent daemon's PUBLIC transport.
 *
 * Everything here is a function of data in and data out, with no socket, so the checks that decide
 * whether a run starts or fails are testable directly. That matters more than usual: the previous
 * adapter's failure mode was that a protocol mismatch produced no error at all, and a guard whose
 * only test is "nothing was reported" cannot tell a working check from an inert one.
 *
 * Verified against the real binary (prime-agent 0.9.1, daemon protocol `prime-agent.daemon` v7,
 * schema `protocol-7-schema-25-585ef1102921`) and against the shipped client implementation in
 * `dist/modes/daemon/daemon-protocol.js` / `daemon-client.js`, not against this repository's own
 * assumptions. See docs/daemon-agent-sessions.md section 3.
 */

export const DAEMON_PROTOCOL_NAME = 'prime-agent.daemon';

/** Highest protocol version this build of Mercury speaks. Negotiated DOWN from the hello, never assumed. */
export const MERCURY_DAEMON_PROTOCOL_VERSION = 7;

/** The daemon only accepts the command envelope at v7 and above (daemon-protocol.js). */
export const DAEMON_ENVELOPE_MIN_PROTOCOL_VERSION = 7;

/**
 * Capabilities Mercury cannot operate without.
 *
 * `event_sequence` is the one that matters: without a server-assigned cursor there is no way to
 * resume after a worker restart without either losing or duplicating events, which is the failure
 * mode Mercury already fixed once for its own event stream (issue #54).
 */
export const REQUIRED_CAPABILITIES = ['event_sequence'] as const;

/** Unix domain socket paths are truncated or rejected past this length; macOS caps at 104 bytes. */
export const MAX_SOCKET_PATH_BYTES = 104;

export interface DaemonHello {
  type: 'daemon_hello';
  protocol: { name: string; version: number };
  schemaId?: string;
  schemaRevision?: number;
  appVersion?: string;
  supervisorGeneration?: string;
  /** Fencing token for supervisor update handoff. NOT a Mercury credential: never log or persist it. */
  supervisorOwnerToken?: string;
  serverCapabilities?: string[];
  [key: string]: unknown;
}

export type HelloCheck =
  | { ok: true; protocolVersion: number; capabilities: string[]; generation: string | null }
  | { ok: false; reason: string; observed: string; expected: string };

/**
 * Decide whether a hello is one Mercury can speak to.
 *
 * Returns the decision rather than throwing so callers can compose it and tests can assert on the
 * specific reason. Every rejection names what was observed and what was expected, because the
 * alternative -- a run that hangs until its timeout -- is what this replaced.
 */
export function checkHello(value: unknown): HelloCheck {
  if (value === null || typeof value !== 'object') {
    return { ok: false, reason: 'first line was not an object', observed: String(value), expected: 'daemon_hello' };
  }
  const hello = value as Partial<DaemonHello>;
  if (hello.type !== 'daemon_hello') {
    return {
      ok: false, reason: 'first message was not a daemon_hello',
      observed: String(hello.type ?? '<no type>'), expected: 'daemon_hello',
    };
  }
  const protocol = hello.protocol;
  if (!protocol || typeof protocol !== 'object') {
    return { ok: false, reason: 'hello carried no protocol', observed: '<none>', expected: DAEMON_PROTOCOL_NAME };
  }
  if (protocol.name !== DAEMON_PROTOCOL_NAME) {
    return {
      ok: false, reason: 'not a PrimeAgent daemon',
      observed: String(protocol.name), expected: DAEMON_PROTOCOL_NAME,
    };
  }
  if (typeof protocol.version !== 'number' || !Number.isInteger(protocol.version)) {
    return {
      ok: false, reason: 'protocol version was not an integer',
      observed: String(protocol.version), expected: `an integer <= ${MERCURY_DAEMON_PROTOCOL_VERSION}`,
    };
  }
  if (protocol.version > MERCURY_DAEMON_PROTOCOL_VERSION) {
    return {
      ok: false, reason: 'daemon speaks a newer protocol than Mercury supports',
      observed: `v${protocol.version}`,
      expected: `<= v${MERCURY_DAEMON_PROTOCOL_VERSION} (upgrade Mercury, or run this host in RPC mode)`,
    };
  }
  if (protocol.version < DAEMON_ENVELOPE_MIN_PROTOCOL_VERSION) {
    return {
      ok: false, reason: 'daemon is too old for the command envelope Mercury requires',
      observed: `v${protocol.version}`, expected: `>= v${DAEMON_ENVELOPE_MIN_PROTOCOL_VERSION}`,
    };
  }
  const capabilities = Array.isArray(hello.serverCapabilities) ? hello.serverCapabilities : [];
  const missing = REQUIRED_CAPABILITIES.filter((c) => !capabilities.includes(c));
  if (missing.length > 0) {
    return {
      ok: false, reason: 'daemon is missing capabilities Mercury requires',
      observed: missing.join(', '),
      expected: `all of [${REQUIRED_CAPABILITIES.join(', ')}]`,
    };
  }
  return {
    ok: true,
    // Mirrors the real client: negotiate down to the lower of the two, so a newer daemon still works
    // with an older Mercury and a mismatch is a decision rather than an assumption.
    //
    // Note for whoever reads this as coverage: the envelope gate below requires >= 7 and the check
    // above rejects > 7, so this expression can only evaluate to 7 today. It is kept because it is
    // what the gate relaxes into, not because a test distinguishes it -- dropping the Math.min here
    // changes no observable behaviour, so no test could catch that mutation.
    protocolVersion: Math.min(protocol.version, MERCURY_DAEMON_PROTOCOL_VERSION),
    capabilities,
    generation: typeof hello.supervisorGeneration === 'string' ? hello.supervisorGeneration : null,
  };
}

/**
 * Classify the very first bytes of a connection.
 *
 * The public supervisor transport is JSONL and its hello starts with `{`. The INTERNAL worker
 * transport -- which the supervisor uses for session workers, and which Mercury must never use --
 * prefixes every frame with two u32 lengths. That transport is gated by an internal token and is
 * free to change without notice, so connecting to it is a configuration error worth naming
 * precisely rather than a parse failure to swallow.
 *
 * This happens in practice: the worker role is selected by the environment variable
 * `PRIME_AGENT_INTERNAL_DAEMON_WORKER`, and a daemon spawned by a process that has it set (any
 * agent-driven dev loop, including a Mercury worker running inside an agent session) comes up as a
 * worker and answers with framed bytes.
 */
export function looksPrivateFramed(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  // A JSONL hello must begin with '{'. Anything else on a socket that claims to be a supervisor is
  // not our transport; the framed layout starts with four zero bytes for a sane header length.
  if (bytes[0] === 0x7b /* { */) return false;
  if (bytes.length < 8) return true;
  const headerLen = bytes.readUInt32BE(0);
  const payloadLen = bytes.readUInt32BE(4);
  return headerLen > 0 && headerLen < (1 << 20) && payloadLen < (1 << 26);
}

export const PRIVATE_TRANSPORT_HINT =
  'the socket answered with length-prefixed frames, which is the daemon\'s INTERNAL worker transport '
  + '(selected by PRIME_AGENT_INTERNAL_DAEMON_WORKER and authenticated by '
  + 'PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN), not the public supervisor protocol. '
  + 'Point MERCURY_DAEMON_SOCKET at the supervisor socket reported by `prime-agent status`, '
  + 'or unset PRIME_AGENT_INTERNAL_DAEMON_WORKER if a daemon was spawned from inside another agent session.';

/**
 * Reject a socket path that cannot work before trying to use it.
 *
 * A Unix socket path over the platform limit fails with EINVAL, and for a daemon that failure
 * surfaces as a worker that never answers -- indistinguishable from a slow start. Checking the
 * length here turns a mysterious hang into one actionable sentence. It is the reason the adapter
 * no longer puts its socket inside the workspace: a deep workspace path can exceed the limit on its
 * own, and did during verification of this design.
 */
export function checkSocketPath(path: string): string | null {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    return `daemon socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit for `
      + `Unix sockets; connect() would fail with EINVAL. Set MERCURY_DAEMON_SOCKET to a shorter path.`;
  }
  return null;
}

export interface CommandEnvelope {
  type: 'command';
  id: string;
  protocol: { name: string; version: number };
  clientId: string;
  command: Record<string, unknown> & { type: string };
}

/**
 * Build the command envelope the daemon requires.
 *
 * A bare `{type:"prompt", message}` is silently unanswered: the daemon does not reply at all, which
 * looks identical to a busy agent. The envelope is what makes a command legible to the supervisor.
 *
 * The inner command is passed through UNCHANGED. An earlier draft stamped the envelope id into it;
 * the daemon's own `createDaemonCommandEnvelope` does not, and its `attach()` sends a command with no
 * inner id at all. Inventing a field here is a needless divergence from the one implementation that
 * defines the contract -- the fidelity test in test/daemonProtocol.test.ts is what caught it.
 */
export function buildCommandEnvelope(input: {
  command: Record<string, unknown> & { type: string };
  id: string;
  clientId: string;
  protocolVersion: number;
}): CommandEnvelope {
  return {
    type: 'command',
    id: input.id,
    protocol: { name: DAEMON_PROTOCOL_NAME, version: input.protocolVersion },
    clientId: input.clientId,
    command: input.command,
  };
}

export type DaemonLine =
  | { kind: 'hello'; hello: unknown }
  | { kind: 'response'; id: string; command: string; success: boolean; data?: unknown; error?: string; errorInfo?: unknown }
  | { kind: 'event'; activeSessionId?: string; sequence?: number; cursor?: unknown; event: Record<string, unknown> }
  /** `session_status`: a recap/idle marker for a session. Informational, never run-ending. */
  | { kind: 'status'; activeSessionId?: string; recap?: string }
  /**
   * `session_closed`: THIS session ended (reason `killed`, `crashed`, ...). Distinct from `closing`,
   * which is the whole daemon shutting down. A run whose session vanished cannot continue, so the
   * adapter must end it rather than wait for a command timeout.
   */
  | { kind: 'session_closed'; activeSessionId?: string; reason: string }
  /** Routine chatter with no run-relevant payload (e.g. `heartbeats_changed`). */
  | { kind: 'ignore'; detail: string }
  | { kind: 'closing'; reason: string }
  | { kind: 'unparsed'; detail: string };

/**
 * Parse one JSONL line into a tagged union.
 *
 * `unparsed` is a result, not an exception, so the caller can log it. Dropping a line silently is
 * what turned every protocol mismatch in this adapter's history into a hung run.
 */
export function parseDaemonLine(line: string): DaemonLine {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: 'unparsed', detail: line.slice(0, 160) };
  }
  if (value === null || typeof value !== 'object') {
    return { kind: 'unparsed', detail: line.slice(0, 160) };
  }
  switch (value.type) {
    case 'daemon_hello':
      return { kind: 'hello', hello: value };
    case 'response':
      return {
        kind: 'response',
        id: String(value.id ?? ''),
        command: String(value.command ?? ''),
        success: value.success === true,
        ...(value.data !== undefined ? { data: value.data } : {}),
        ...(value.error !== undefined ? { error: String(value.error) } : {}),
        ...(value.errorInfo !== undefined ? { errorInfo: value.errorInfo } : {}),
      };
    case 'session_event': {
      // The real supervisor puts the ordering information in `meta`, not at the top level:
      // meta = { id: "<session>:<seq>", protocol, activeSessionId, sequence, cursor, emittedAt }.
      // Reading only top-level fields yields a cursor that never advances.
      const meta = (typeof value.meta === 'object' && value.meta !== null ? value.meta : {}) as Record<string, unknown>;
      const sequence = typeof value.sequence === 'number' ? value.sequence
        : typeof meta.sequence === 'number' ? meta.sequence : undefined;
      const cursor = value.cursor ?? meta.cursor;
      const activeSessionId = typeof value.activeSessionId === 'string' ? value.activeSessionId
        : typeof meta.activeSessionId === 'string' ? meta.activeSessionId : undefined;
      return {
        kind: 'event',
        ...(activeSessionId !== undefined ? { activeSessionId } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        event: (typeof value.event === 'object' && value.event !== null ? value.event : {}) as Record<string, unknown>,
      };
    }
    case 'session_status': {
      const meta = (typeof value.meta === 'object' && value.meta !== null ? value.meta : {}) as Record<string, unknown>;
      return {
        kind: 'status',
        ...(typeof value.activeSessionId === 'string' ? { activeSessionId: value.activeSessionId } : {}),
        ...(typeof value.recap === 'string' ? { recap: value.recap } : {}),
        ...(typeof meta.recap === 'string' ? { recap: meta.recap } : {}),
      };
    }
    case 'session_closed':
      return {
        kind: 'session_closed',
        ...(typeof value.activeSessionId === 'string' ? { activeSessionId: value.activeSessionId } : {}),
        reason: String(value.reason ?? 'closed'),
      };
    case 'heartbeats_changed':
      return { kind: 'ignore', detail: 'heartbeats_changed' };
    case 'daemon_closing':
      return { kind: 'closing', reason: String(value.reason ?? 'daemon is shutting down') };
    default:
      return { kind: 'unparsed', detail: `type=${String(value.type ?? '<none>')}` };
  }
}

/**
 * A copy of the hello that is safe to log or persist.
 *
 * `supervisorOwnerToken` is a fencing token for supervisor update handoff. It is not a Mercury
 * credential, and a log line containing it is a live capability sitting in journald with the
 * retention policy of a log file.
 */
export function helloForLogging(hello: Partial<DaemonHello>): Record<string, unknown> {
  const { supervisorOwnerToken: _omit, ...rest } = hello as Record<string, unknown>;
  return rest;
}

/**
 * Convert the RPC-shaped dialog answer into the daemon's `extension_ui_response` command payload.
 *
 * The two transports disagree here and the disagreement is silent: the RPC form is flat
 * (`{id, value}`), the daemon form is `{requestId, response}`. Sending the flat form over the daemon
 * socket answers nothing, and nothing complains.
 *
 * The three-way split below is transcribed from the vendor's own RPC-to-daemon bridge
 * (`dist/modes/rpc/rpc-mode.js`, the `extension_ui_response` branch), including its ordering: a
 * cancelled answer wins over a value, and a value wins over a confirmation. Reordering those changes
 * which answer a run gets.
 */
export function toDaemonUiResponse(rpc: Record<string, unknown>): {
  requestId: string;
  response: Record<string, unknown>;
} {
  const requestId = typeof rpc.id === 'string' ? rpc.id : '';
  const response = 'cancelled' in rpc && rpc.cancelled
    ? { cancelled: true }
    : 'value' in rpc
      ? { value: rpc.value }
      : { confirmed: 'confirmed' in rpc && Boolean(rpc.confirmed) };
  return { requestId, response };
}
