/**
 * Probe one Mercury host over HTTP.
 *
 * Three endpoints, each answering a different question, and the outcomes are kept separate on purpose:
 *
 *   GET /healthz          is anything there, and is it Mercury?          (public, no credential)
 *   GET /healthz/workers  is it actually serving work?                    (public, no credential)
 *   GET /api/agents       is our credential good, and what can it run?    (requires credential)
 *
 * Collapsing these into "down" is the mistake the design calls out in section 7: a host that refuses our
 * token, a host whose worker is not running, and a host that is unplugged all need different fixes, and a
 * single status string would send the operator to the wrong one.
 */

import type { ProbeOutcome, ProbeRecord } from './registry.ts';

export interface ProbeTarget {
  hostId: string;
  baseUrl: string;
  /** The secret, resolved by the caller from the credential file. Never read from argv. */
  token: string;
  timeoutMs: number;
}

export interface ProbeResult {
  outcome: ProbeOutcome;
  detail: string | null;
  activeRuns: number | null;
  queueDepth: number | null;
  workerCount: number | null;
  workerId: string | null;
  agents: string[] | null;
  lastError: string | null;
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Strip terminal control sequences from text a CHILD produced.
 *
 * Fleet's trust boundary is HTTP: it may be pointed at a Mercury it did not build, and any child it can
 * reach can answer with arbitrary JSON. Without this, a hostile or compromised child returns
 * `{"error": "\u001b]0;pwned\u0007..."}` from /healthz/workers and writes raw escapes into the operator's
 * terminal -- enough to set the window title, clear the screen, or print a line that looks like Fleet's own
 * output. Verified against a live fake before this function existed.
 *
 * Applied where child text enters the system rather than at each print site, so a future command cannot
 * forget to sanitize. Control characters are removed rather than escaped: `detail` is a single-line
 * diagnostic, and a newline is exactly how a child would forge a second one.
 */
export function stripTerminalControls(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC ... BEL or ST
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI ... final byte
    .replace(/[\u0000-\u001f\u007f]/g, ''); // remaining C0 (incl. CR/LF/TAB) and DEL
}

/** Shape of Mercury's /healthz/workers. camelCase: activeLeases() maps its SQL aliases before responding. */
interface WorkersResponse {
  workers?: Array<{ workerId?: string; activeRuns?: number }>;
  queueDepth?: number;
}

interface AgentsResponse {
  agents?: unknown;
}

/**
 * One HTTP call with a hard deadline.
 *
 * The timeout is per request rather than per probe: a host that answers /healthz instantly and then hangs on
 * /api/agents must still report what /healthz told us, and must not hold the sweep open for three times the
 * timeout.
 */
async function call(
  fetchImpl: FetchLike,
  url: string,
  token: string | null,
  timeoutMs: number,
): Promise<{ status: number; json: unknown | null; transportError: Error | null; timedOut: boolean }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { name?: string; cause?: { code?: string } };
    // AbortSignal.timeout surfaces as TimeoutError; a plain abort would be named AbortError. Naming the
    // difference matters in the report: a slow host and a refused host are different problems.
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { status: 0, json: null, transportError: e, timedOut };
  }
  let json: unknown | null = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body. Left null so the caller can report the status, which is the useful part.
  }
  return { status: res.status, json, transportError: null, timedOut: false };
}

function describeTransportError(err: Error): string {
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  if (cause?.code) return `${cause.code}`;
  return err.message.slice(0, 200);
}

/** Probe a host. Never throws: every failure mode becomes a classified outcome, because a sweep must
 * report on all hosts rather than abort on the first bad one. */
export async function probeHost(target: ProbeTarget, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const base = target.baseUrl;
  const empty: ProbeResult = {
    outcome: 'unreachable',
    detail: null,
    activeRuns: null,
    queueDepth: null,
    workerCount: null,
    workerId: null,
    agents: null,
    lastError: null,
  };

  // 1) Liveness. Nothing else is meaningful until we know something is listening.
  const health = await call(fetchImpl, `${base}/healthz`, null, target.timeoutMs);
  if (health.transportError) {
    return {
      ...empty,
      outcome: health.timedOut ? 'timeout' : 'unreachable',
      detail: health.timedOut
        ? `no response within ${target.timeoutMs} ms`
        : describeTransportError(health.transportError),
      lastError: health.transportError.message.slice(0, 300),
    };
  }
  if (health.status === 404) {
    return {
      ...empty,
      outcome: 'not_mercury',
      detail: 'answered but has no /healthz, so this is not a Mercury API',
      lastError: `HTTP 404 from ${base}/healthz`,
    };
  }
  if (health.status < 200 || health.status >= 300) {
    return {
      ...empty,
      outcome: 'http_error',
      detail: `HTTP ${health.status} from /healthz`,
      lastError: `HTTP ${health.status} from ${base}/healthz`,
    };
  }

  // 2) Serving. /healthz proves the API process; this proves a worker is claiming work.
  const workers = await call(fetchImpl, `${base}/healthz/workers`, null, target.timeoutMs);
  let activeRuns: number | null = null;
  let queueDepth: number | null = null;
  let workerCount: number | null = null;
  let workerId: string | null = null;
  let notServingDetail: string | null = null;
  let capacityUnknown: string | null = null;

  if (workers.transportError) {
    return {
      ...empty,
      outcome: workers.timedOut ? 'timeout' : 'unreachable',
      detail: `/healthz answered but /healthz/workers failed: ${describeTransportError(workers.transportError)}`,
      lastError: workers.transportError.message.slice(0, 300),
    };
  }
  if (workers.status === 503) {
    // Reachable and serving HTTP, but no queue wired up: this Mercury cannot execute anything. Distinct
    // from unreachable because the fix is operator-side configuration, not a network or host problem.
    notServingDetail = stripTerminalControls(
      (workers.json as { error?: string } | null)?.error ?? 'queue not configured');
  } else if (workers.status === 404) {
    // An older Mercury that predates the endpoint. It is still perfectly dispatchable, so this is NOT
    // not_serving: that outcome means "cannot execute anything", and claiming it here would take a healthy
    // host out of rotation because of a missing telemetry route.
    capacityUnknown = 'no /healthz/workers endpoint; capacity unknown (older Mercury?)';
  } else if (workers.status < 200 || workers.status >= 300) {
    return {
      ...empty,
      outcome: 'http_error',
      detail: `HTTP ${workers.status} from /healthz/workers`,
      lastError: `HTTP ${workers.status} from ${base}/healthz/workers`,
    };
  } else {
    const body = (workers.json ?? {}) as WorkersResponse;
    const list = Array.isArray(body.workers) ? body.workers : [];
    workerCount = list.length;
    // Sum rather than take one: a host may run several workers, and "how busy is this machine" is the
    // question routing will eventually ask.
    activeRuns = list.reduce((sum, w) => sum + (typeof w.activeRuns === 'number' ? w.activeRuns : 0), 0);
    workerId = list.map((w) => w.workerId).filter((x): x is string => typeof x === 'string').join(',') || null;
    queueDepth = typeof body.queueDepth === 'number' ? body.queueDepth : null;
  }

  // 3) Credential and capability. This is the only authenticated call, so it is where a bad token shows up.
  const agents = await call(fetchImpl, `${base}/api/agents`, target.token, target.timeoutMs);
  let agentList: string[] | null = null;
  let agentsDetail: string | null = null;
  let unauthorized = false;

  if (agents.transportError) {
    return {
      ...empty,
      outcome: agents.timedOut ? 'timeout' : 'unreachable',
      detail: `/healthz answered but /api/agents failed: ${describeTransportError(agents.transportError)}`,
      lastError: agents.transportError.message.slice(0, 300),
    };
  }
  if (agents.status === 401 || agents.status === 403) {
    unauthorized = true;
    agentsDetail = `HTTP ${agents.status} from /api/agents: the host is reachable but this credential was ` +
      `rejected. Check credential_ref; do not assume the host is down.`;
  } else if (agents.status >= 200 && agents.status < 300) {
    const raw = (agents.json as AgentsResponse | null)?.agents;
    agentList = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string').map(stripTerminalControls)
      : [];
  } else {
    agentsDetail = `HTTP ${agents.status} from /api/agents`;
  }

  // Precedence: a host we cannot authenticate against is reported as unauthorized even though it is
  // healthy, because that is the condition blocking Fleet from using it.
  if (unauthorized) {
    return { ...empty, outcome: 'unauthorized', detail: agentsDetail, agents: null,
             activeRuns, queueDepth, workerCount, workerId, lastError: agentsDetail };
  }
  if (notServingDetail) {
    return { ...empty, outcome: 'not_serving', detail: notServingDetail, agents: agentList,
             activeRuns, queueDepth, workerCount, workerId, lastError: notServingDetail };
  }
  if (agentsDetail) {
    return { ...empty, outcome: 'http_error', detail: agentsDetail, agents: agentList,
             activeRuns, queueDepth, workerCount, workerId, lastError: agentsDetail };
  }
  return {
    outcome: 'ok',
    detail: capacityUnknown,
    activeRuns,
    queueDepth,
    workerCount,
    workerId,
    agents: agentList,
    lastError: null,
  };
}

/** Run a probe and shape it into a registry record. */
export async function probeAndRecord(
  target: ProbeTarget,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeRecord> {
  const r = await probeHost(target, fetchImpl);
  return {
    hostId: target.hostId,
    outcome: r.outcome,
    detail: r.detail,
    activeRuns: r.activeRuns,
    queueDepth: r.queueDepth,
    workerCount: r.workerCount,
    workerId: r.workerId,
    agents: r.agents,
    probedAt: new Date().toISOString(),
    lastError: r.lastError,
  };
}
