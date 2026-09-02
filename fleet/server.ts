/**
 * The Fleet service: an HTTP server over the registry and the prober.
 *
 * The route table is enumerated rather than grown ad hoc (docs/fleet-design.md section 15.4). The rule that
 * matters is that nothing here accepts a URL to fetch: a caller names a host by its registry id and Fleet
 * resolves it. That is what keeps section 9's "do not proxy arbitrary paths to children" true as the surface
 * grows, instead of eroding one convenience at a time.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import { HostRegistry, RegistryError, type HostView } from './registry.ts';
import { createProber, type Prober } from './prober.ts';
import { CredentialError, type CredentialStore } from './credentials.ts';
import type { Caller } from './auth.ts';
import { parseCallerTokens, hostAllowed } from './auth.ts';
import { authenticate, HttpError, matchRoute, readJsonBody, sendJson, type Route } from './http.ts';
import type { Logger } from './logger.ts';
import type { FleetConfig } from './config.ts';

export interface FleetServerDeps {
  db: DatabaseSync;
  config: FleetConfig;
  credentials: CredentialStore;
  logger: Logger;
}

export interface FleetServer {
  server: Server;
  prober: Prober;
  routes: Route[];
  /** Bind, then start the sweep. Resolves once listening. */
  listen: () => Promise<{ host: string; port: number; tls: boolean }>;
  close: () => Promise<void>;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${key} is required and must be a non-empty string`);
  return v;
}

/** Hosts this caller may see. Admins and `*` callers see everything. */
function visibleHosts(registry: HostRegistry, caller: Caller): HostView[] {
  const all = registry.listWithProbe();
  if (caller.isAdmin || caller.allowedHosts === '*') return all;
  return all.filter((h) => caller.allowedHosts.includes(h.id));
}

export function buildRoutes(deps: FleetServerDeps): { routes: Route[]; prober: Prober } {
  const registry = new HostRegistry(deps.db);
  const prober = createProber({
    registry,
    resolveToken: (ref) => deps.credentials.secret(ref),
    intervalMs: deps.config.probeIntervalMs,
    timeoutMs: deps.config.probeTimeoutMs,
  });

  const routes: Route[] = [
    {
      method: 'GET', pattern: ['healthz'], public: true,
      handle: (_ctx, res) => sendJson(res, 200, { ok: true, ts: new Date().toISOString() }),
    },
    {
      // Registry reads. A caller sees only the hosts it may act on; naming a host it may not touch is a
      // 403 elsewhere, never a silent substitution.
      method: 'GET', pattern: ['fleet', 'hosts'],
      handle: (ctx, res) => sendJson(res, 200, { hosts: visibleHosts(registry, ctx.caller) }),
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts'], admin: true,
      handle: (ctx, res) => {
        const b = bodyObject(ctx.body);
        // Reject an unknown ref at registration. Accepting a typo defers the failure to a probe that reports
        // auth-fail, which points at the host when the mistake is in this request.
        const ref = str(b, 'credentialRef');
        deps.credentials.secret(ref);
        const host = registry.add({
          id: str(b, 'id'),
          baseUrl: str(b, 'baseUrl'),
          credentialRef: ref,
          labels: (b.labels ?? {}) as Record<string, string>,
          localPaths: (b.localPaths ?? []) as string[],
          enabled: b.enabled !== false,
        });
        sendJson(res, 201, { host });
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts', ':id', 'enable'], admin: true,
      handle: (ctx, res) => {
        const b = bodyObject(ctx.body);
        const host = registry.setEnabled(ctx.params[0]!, b.enabled !== false);
        sendJson(res, 200, { host });
      },
    },
    {
      method: 'DELETE', pattern: ['fleet', 'hosts', ':id'], admin: true,
      handle: (ctx, res) => {
        if (!registry.remove(ctx.params[0]!)) throw new HttpError(404, 'no such host');
        sendJson(res, 200, { removed: ctx.params[0] });
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts', ':id', 'probe'], admin: true,
      handle: async (ctx, res) => {
        const id = ctx.params[0]!;
        const host = registry.get(id);
        if (!host) throw new HttpError(404, 'no such host');
        const { probeAndRecord } = await import('./probe.ts');
        const rec = await probeAndRecord({
          hostId: id, baseUrl: host.baseUrl,
          token: deps.credentials.secret(host.credentialRef),
          timeoutMs: deps.config.probeTimeoutMs,
        });
        registry.recordProbe(rec);
        sendJson(res, 200, { probe: rec });
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'probe'], admin: true,
      handle: async (_ctx, res) => {
        const results = await prober.sweepOnce();
        sendJson(res, 200, { probed: results.length, hosts: registry.listWithProbe() });
      },
    },
  ];

  return { routes, prober };
}

export function createFleetServer(deps: FleetServerDeps): FleetServer {
  const { routes, prober } = buildRoutes(deps);
  const registry = new HostRegistry(deps.db);
  // Parsed once, not per request: the token set is fixed at startup, and re-splitting it on every call
  // would let a caller's request rate scale the cost of an operation that never changes.
  const authDeps = { callers: parseCallerTokens(deps.config.apiTokens), adminToken: deps.config.adminToken };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const matched = matchRoute(routes, req.method ?? 'GET', path);
    if (!matched) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const { route, params } = matched;
    try {
      let caller: Caller = { ownerId: 'anonymous', isAdmin: false, allowedHosts: [] };
      if (!route.public) {
        const resolved = authenticate(req, authDeps);
        if (!resolved) {
          sendJson(res, 401, { error: 'authentication required' });
          return;
        }
        caller = resolved;
        if (route.admin && !caller.isAdmin) {
          sendJson(res, 403, { error: 'administrator token required' });
          return;
        }
      }
      const body = route.method === 'POST' ? await readJsonBody(req) : {};
      await route.handle({ caller, params, query: url.searchParams, body, log: deps.logger }, res);
    } catch (err) {
      // All three are the caller's mistake rather than a server fault, so all three are 4xx. CredentialError
      // in particular names a credential_ref that is not in the file -- returning 500 for that sends the
      // operator to the service logs when the answer is in their own request body.
      if (err instanceof HttpError || err instanceof RegistryError || err instanceof CredentialError) {
        const status = err instanceof HttpError ? err.status : 400;
        sendJson(res, status, { error: err.message });
        return;
      }
      // The logger redacts, so an exception message carrying a header cannot reach the log intact.
      deps.logger.error('request failed', { method: req.method, path, err: err as Error });
      sendJson(res, 500, { error: 'internal error' });
    }
  };

  const tls = Boolean(deps.config.tlsCert && deps.config.tlsKey);
  const server = tls
    ? https.createServer(
        { cert: readFileSync(deps.config.tlsCert!), key: readFileSync(deps.config.tlsKey!) },
        handler,
      )
    : createServer(handler);
  // A dashboard holding an open stream must not stall `systemctl stop` until SIGKILL.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;

  return {
    server,
    prober,
    routes,
    async listen() {
      // Startup order from section 15.6: credentials were loaded by the caller, the database is open, and
      // reconciliation happens here. Binding LAST means a client can never get a response from an endpoint
      // that has not finished loading the registry.
      const hosts = registry.list();
      deps.logger.info('fleet starting', {
        hosts: hosts.length,
        bindHost: deps.config.bindHost,
        port: deps.config.port,
        tls,
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.config.port, deps.config.bindHost, () => resolve());
      });
      const addr = server.address();
      prober.start();
      // Sweep once immediately so the first GET /fleet/hosts is not all "never-probed".
      void prober.sweepOnce().catch((err: Error) => deps.logger.error('initial sweep failed', { err }));
      return {
        host: deps.config.bindHost,
        port: typeof addr === 'object' && addr ? addr.port : deps.config.port,
        tls,
      };
    },
    async close() {
      // In-flight probes are abandoned, not awaited: the sweep writes cache rows and cache is cheap to lose.
      prober.stop();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

export { hostAllowed };
