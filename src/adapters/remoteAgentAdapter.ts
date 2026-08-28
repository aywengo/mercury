// RemoteAgentAdapter: generic adapter for cloud/SaaS coding agents exposed
// over HTTP (Mercury docs/agent-adapters.md section 5).
//
// Everything is declarative config: base URL, auth, create/get/events/input/
// cancel endpoints, polling, event mapping. No per-agent code.

import type {
  AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext,
} from '../domain/types.ts';
import type { LocalAgentEventMap } from './localAgentAdapter.ts';

// --- config schema (docs/agent-adapters.md section 5.1) ---------------------

export interface RemoteAgentAuth {
  type: 'bearer' | 'header' | 'query';
  /** header name for bearer/header; query param name for query (default "api_key"). */
  headerName?: string;
  /** env var holding the credential (e.g. MERCURY_DEVIN_API_KEY). */
  envVar: string;
}

export interface RemoteAgentEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

export interface RemoteAgentCreateTask extends RemoteAgentEndpoint {
  /** body template; {task} and {workspace} placeholders. */
  body: Record<string, unknown>;
  /** response field with the task id (dot path, e.g. "session.id"). */
  idField: string;
}

export interface RemoteAgentGetTask extends RemoteAgentEndpoint {
  statusField: string;
  statusMap: Record<string, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>;
}

export interface RemoteAgentEvents extends RemoteAgentEndpoint {
  eventField: string;
  eventTypeField: string;
}

export interface RemoteAgentSendInput extends RemoteAgentEndpoint {
  /** body template; {input} placeholder. */
  body: Record<string, unknown>;
}

export interface RemoteAgentConfig {
  id: string;
  description: string;
  api: {
    baseUrl: string;
    auth: RemoteAgentAuth;
    createTask: RemoteAgentCreateTask;
    getTask: RemoteAgentGetTask;
    events?: RemoteAgentEvents;
    sendInput?: RemoteAgentSendInput;
    cancel?: RemoteAgentEndpoint;
  };
  poll: {
    intervalMs: number;
    timeoutMs: number;
  };
  /** event mapping: agent event type -> Mercury event type (same shape as LocalAgentAdapter). */
  eventMap: LocalAgentEventMap;
}

export interface RemoteAgentAdapterOptions {
  /** injectable HTTP client for tests (defaults to global fetch). */
  http?: (url: string, init: RequestInit) => Promise<Response>;
  /** clock for tests (defaults to Date.now). */
  now?: () => number;
}

// --- validation -------------------------------------------------------------

export function validateRemoteAgentConfig(cfg: RemoteAgentConfig): void {
  const err = (msg: string): never => { throw new Error(`RemoteAgentConfig "${cfg.id}": ${msg}`); };
  if (!cfg.id) err('id is required');
  if (!cfg.api?.baseUrl) err('api.baseUrl is required');
  if (!/^https?:\/\//.test(cfg.api.baseUrl)) err('api.baseUrl must be an http(s) URL');
  const auth = cfg.api.auth;
  if (!auth || !['bearer', 'header', 'query'].includes(auth.type)) err('api.auth.type must be bearer|header|query');
  if (!auth.envVar) err('api.auth.envVar is required');
  if ((auth.type === 'bearer' || auth.type === 'header') && !auth.headerName) err('api.auth.headerName required for bearer/header');
  const ct = cfg.api.createTask;
  if (!ct || ct.method !== 'POST' || !ct.path || !ct.body || !ct.idField) err('api.createTask must be POST with path, body, idField');
  const gt = cfg.api.getTask;
  if (!gt || !gt.path || !gt.statusField || !gt.statusMap || Object.keys(gt.statusMap).length === 0) err('api.getTask requires path, statusField, statusMap');
  if (cfg.api.events && (!cfg.api.events.eventField || !cfg.api.events.eventTypeField)) err('api.events requires eventField and eventTypeField');
  if (cfg.api.sendInput && !cfg.api.sendInput.body) err('api.sendInput requires body');
  if (!cfg.poll || !(cfg.poll.intervalMs > 0) || !(cfg.poll.timeoutMs > 0)) err('poll.intervalMs and poll.timeoutMs must be positive');
  if (!cfg.eventMap || typeof cfg.eventMap !== 'object') err('eventMap is required');
}

// --- helpers ----------------------------------------------------------------

/** Resolve "a.b.c" paths in a response object. */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace {id} in a path template. */
function templatePath(path: string, id: string): string {
  return path.replaceAll('{id}', encodeURIComponent(id));
}

/** Deep-replace {task}/{workspace}/{input} placeholders in a body template. */
function templateBody(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
    return out;
  }
  if (Array.isArray(template)) return template.map((x) => templateBody(x, vars));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = templateBody(v, vars);
    }
    return out;
  }
  return template;
}

// --- session state ----------------------------------------------------------

interface Session {
  runId: string;
  config: RemoteAgentConfig;
  taskId: string | null;
  done: boolean;
  cancelled: boolean;
  terminated: boolean;
  exitSettled: boolean;
  queue: AgentEvent[];
  waiters: ((ev: AgentEvent) => void)[];
  exitPromise: Promise<AgentExit>;
  exitResolve: (exit: AgentExit) => void;
  /** events already emitted (count-based dedup) */
  emittedEvents: number;
  /** poll loop control */
  pollAbort: AbortController | null;
  /** last poll error (for infrastructure-failure detection) */
  lastError: string | null;
}

const DONE: AgentEvent = { type: '__done__', payload: {} };

// --- adapter ----------------------------------------------------------------

export class RemoteAgentAdapter implements AgentAdapter {
  private cfg: RemoteAgentConfig;
  private opts: RemoteAgentAdapterOptions;
  private sessions = new Map<string, Session>();

  constructor(cfg: RemoteAgentConfig, opts: RemoteAgentAdapterOptions = {}) {
    validateRemoteAgentConfig(cfg);
    this.cfg = cfg;
    this.opts = opts;
  }

  get config(): RemoteAgentConfig {
    return this.cfg;
  }

  private http(url: string, init: RequestInit): Promise<Response> {
    return this.opts.http ? this.opts.http(url, init) : fetch(url, init);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Build the auth headers/query for a request. The credential never leaves this method. */
  private authFor(): { headers: Record<string, string>; query: Record<string, string> } {
    const auth = this.cfg.api.auth;
    const token = process.env[auth.envVar];
    if (!token) {
      throw new Error(`RemoteAgentAdapter: credential env var ${auth.envVar} is not set`);
    }
    if (auth.type === 'query') {
      return { headers: {}, query: { [auth.headerName ?? 'api_key']: token } };
    }
    const headerName = auth.headerName ?? 'Authorization';
    const value = auth.type === 'bearer' ? `Bearer ${token}` : token;
    return { headers: { [headerName]: value }, query: {} };
  }

  private async request(
    endpoint: RemoteAgentEndpoint,
    vars: Record<string, unknown>,
    taskId: string | null,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const { headers, query } = this.authFor();
    const path = templatePath(endpoint.path, taskId ?? '');
    const url = new URL(this.cfg.api.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: endpoint.method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (endpoint.method !== 'GET' && 'body' in endpoint) {
        const body = templateBody((endpoint as { body: unknown }).body, vars);
        init.body = JSON.stringify(body);
      }
      const resp = await this.http(url.toString(), init);
      let body: unknown = null;
      const text = await resp.text();
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { status: resp.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    const session: Session = {
      runId,
      config: this.cfg,
      taskId: null,
      done: false,
      cancelled: false,
      terminated: false,
      exitSettled: false,
      queue: [],
      waiters: [],
      exitPromise: undefined as unknown as Promise<AgentExit>,
      exitResolve: undefined as unknown as (exit: AgentExit) => void,
      emittedEvents: 0,
      pollAbort: null,
      lastError: null,
    };
    session.exitPromise = new Promise<AgentExit>((resolve) => {
      session.exitResolve = resolve;
    });
    this.sessions.set(runId, session);

    // 1. create the remote task
    const ct = this.cfg.api.createTask;
    const createResp = await this.request(ct, {
      task: context.run.task,
      workspace: context.workspace.path,
    }, null, 15_000);
    if (createResp.status >= 400) {
      throw new Error(`RemoteAgentAdapter: createTask failed with HTTP ${createResp.status}`);
    }
    const taskId = getByPath(createResp.body, ct.idField);
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error(`RemoteAgentAdapter: createTask response missing idField "${ct.idField}"`);
    }
    session.taskId = taskId;

    // 2. start the poll loop (emits events, resolves exit on terminal status)
    this.startPolling(session);

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }

  private startPolling(session: Session): void {
    const cfg = session.config;
    const abort = new AbortController();
    session.pollAbort = abort;
    const startedAt = this.now();
    const deadline = startedAt + cfg.poll.timeoutMs;

    const tick = async (): Promise<void> => {
      if (session.done || session.exitSettled || abort.signal.aborted) return;
      try {
        // fetch events first (so messages arrive before the terminal status)
        if (cfg.api.events) {
          await this.fetchEvents(session);
        }
        const gt = cfg.api.getTask;
        const resp = await this.request(gt, {}, session.taskId, 15_000);
        if (resp.status >= 400) {
          session.lastError = `getTask HTTP ${resp.status}`;
          throw new Error(`RemoteAgentAdapter: getTask failed with HTTP ${resp.status}`);
        }
        session.lastError = null;
        const status = getByPath(resp.body, gt.statusField);
        const mapped = typeof status === 'string' ? gt.statusMap[status] : undefined;
        if (mapped === 'completed') {
          finish(session, { code: 0, signal: null, reason: 'completed' });
          return;
        }
        if (mapped === 'failed') {
          finish(session, { code: 1, signal: null, reason: 'failed' });
          return;
        }
        if (mapped === 'cancelled') {
          finish(session, { code: null, signal: null, reason: 'cancelled' });
          return;
        }
        if (mapped === undefined && status !== undefined) {
          // unknown status: treat as running (vendor may add statuses)
          session.lastError = null;
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        session.lastError = message;
        // transient API failure: keep polling (infrastructure retry happens at run level)
      }
      if (this.now() >= deadline) {
        finish(session, { code: null, signal: null, reason: 'timeout' });
        return;
      }
      setTimeout(() => { void tick(); }, cfg.poll.intervalMs);
    };

    void tick();
  }

  private async fetchEvents(session: Session): Promise<void> {
    const cfg = session.config;
    const ev = cfg.api.events!;
    const resp = await this.request(ev, {}, session.taskId, 15_000);
    if (resp.status >= 400) throw new Error(`RemoteAgentAdapter: events failed with HTTP ${resp.status}`);
    const list = getByPath(resp.body, ev.eventField);
    if (!Array.isArray(list)) return;
    for (let i = session.emittedEvents; i < list.length; i++) {
      const item = list[i] as Record<string, unknown>;
      const agentType = typeof item[ev.eventTypeField] === 'string' ? item[ev.eventTypeField] as string : null;
      if (agentType === null) continue;
      this.handleAgentEvent(session, agentType, item);
    }
    session.emittedEvents = list.length;
  }

  private handleAgentEvent(session: Session, agentType: string, payload: Record<string, unknown>): void {
    const cfg = session.config;
    const map = cfg.eventMap;
    // human input prompt
    if (cfg.api.sendInput && map[agentType] === 'input.required') {
      push(session, { type: 'input.required', payload });
      return;
    }
    const hermesType = map[agentType];
    if (typeof hermesType === 'string') {
      push(session, { type: hermesType, payload });
    }
  }

  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) throw new Error(`No live agent session for run ${runId}`);
    const si = session.config.api.sendInput;
    if (!si) throw new Error(`Agent ${session.config.id} does not support sendInput`);
    const resp = await this.request(si, { input: input.value }, session.taskId, 15_000);
    if (resp.status >= 400) throw new Error(`RemoteAgentAdapter: sendInput failed with HTTP ${resp.status}`);
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.cancelled || session.exitSettled) return;
    session.cancelled = true;
    session.done = true;
    const ce = session.config.api.cancel;
    if (ce) {
      try {
        await this.request(ce, {}, session.taskId, 15_000);
      } catch {
        // design: if cancel fails, mark cancelled locally anyway
      }
    }
    session.pollAbort?.abort();
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: null, reason: 'cancelled' });
  }

  async terminate(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.terminated || session.exitSettled) return;
    session.terminated = true;
    session.done = true;
    session.pollAbort?.abort();
    for (const waiter of session.waiters.splice(0)) waiter(DONE);
    settleExit(session, { code: null, signal: null, reason: 'terminated' });
  }

  /** Resume: re-attach to the existing remote task instead of creating a new one. */
  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    let session = this.sessions.get(runId);
    if (!session) {
      if (!context) throw new Error(`No session state for run ${runId}; resume requires a run context`);
      session = {
        runId,
        config: this.cfg,
        taskId: null,
        done: false,
        cancelled: false,
        terminated: false,
        exitSettled: false,
        queue: [],
        waiters: [],
        exitPromise: undefined as unknown as Promise<AgentExit>,
        exitResolve: undefined as unknown as (exit: AgentExit) => void,
        emittedEvents: 0,
        pollAbort: null,
        lastError: null,
      };
      session.exitPromise = new Promise<AgentExit>((resolve) => {
        session!.exitResolve = resolve;
      });
      this.sessions.set(runId, session);
    }
    if (!session.taskId) throw new Error(`No remote task id for run ${runId}; use retry-from-scratch`);
    session.done = false;
    session.cancelled = false;
    session.terminated = false;
    session.exitSettled = false;
    session.exitPromise = new Promise<AgentExit>((resolve) => {
      session.exitResolve = resolve;
    });
    this.startPolling(session);

    return {
      runId,
      events: eventsGenerator(session),
      exit: session.exitPromise,
      terminate: async () => this.terminate(runId),
    };
  }
}

// --- helpers ----------------------------------------------------------------

function finish(session: Session, exit: AgentExit): void {
  if (session.exitSettled) return;
  session.done = true;
  for (const waiter of session.waiters.splice(0)) waiter(DONE);
  settleExit(session, exit);
}

function settleExit(session: Session, exit: AgentExit): void {
  if (session.exitSettled) return;
  session.exitSettled = true;
  session.exitResolve(exit);
}

function push(session: Session, ev: AgentEvent): void {
  const waiter = session.waiters.shift();
  if (waiter) waiter(ev);
  else session.queue.push(ev);
}

function eventsGenerator(session: Session): AsyncGenerator<AgentEvent> {
  return (async function* () {
    while (true) {
      if (session.queue.length > 0) {
        yield session.queue.shift()!;
      } else if (session.done) {
        return;
      } else {
        const ev = await new Promise<AgentEvent>((resolve) => session.waiters.push(resolve));
        if (ev === DONE) {
          while (session.queue.length > 0) yield session.queue.shift()!;
          return;
        }
        yield ev;
      }
    }
  })();
}
