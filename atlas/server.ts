/**
 * The Atlas HTTP surface (docs/knowledge-base.md section 11.1).
 *
 * Three rules hold everywhere and are worth stating once, because every route below obeys them:
 *
 * **404, not 403, for a project the caller is not bound to.** The existence of a project is itself
 * information. This is the same reasoning the host applies to a foreign Run, and it is why the check
 * happens before any read rather than as a filter on the result.
 *
 * **No route proxies to a host, and no route accepts a payload Atlas does not validate.** Atlas does not
 * know what a Run is beyond the `runId` string in provenance, and it must never grow an endpoint that
 * does.
 *
 * **Request bodies are never logged.** A `claim` is a project claim that may contain anything an agent
 * learned, including something it should not have written down. Section 11.5 asks for request lines
 * without bodies, and this file is the only place that could break it.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { AtlasConfig } from './config.ts';
import { AuthIndex, hashToken, type Caller } from './auth.ts';
import { authenticate, HttpError, matchRoute, readJsonBody, sendJson, type Route } from './http.ts';
import type { Logger } from './logger.ts';
import { AtlasMetrics } from './metrics.ts';
import { ClaimConflictError, NoteStore, type PromotionPolicy } from './notes.ts';
import { startMaintenanceSweep } from './sweep.ts';
import { ATLAS_PRODUCT, ATLAS_VERSION } from './version.ts';

export interface AtlasServices {
  db: DatabaseSync;
  config: AtlasConfig;
  store: NoteStore;
  auth: AuthIndex;
  log: Logger;
  metrics: AtlasMetrics;
}

const DEFAULT_FEED_LIMIT = 500;
const MAX_FEED_LIMIT = 500;

export function buildRoutes(services: AtlasServices): Route[] {
  const { store, config, metrics, log } = services;

  const requireProject = (caller: Caller, projectId: string): void => {
    if (!services.auth.mayAccess(caller, projectId)) {
      // 404 rather than 403, and the same body either way, so a probe cannot tell "not bound to you"
      // from "does not exist".
      throw new HttpError(404, `no such project: ${projectId}`);
    }
  };

  const isReader = (caller: Caller): boolean => caller.class === 'reader';

  return [
    {
      method: 'GET', pattern: ['healthz'], public: true,
      handle: (_ctx, res) => {
        // The shape Fleet already probes on hosts, so an operator can point one prober at all three
        // products. `api` is absent on purpose: Atlas has no versioned Run contract.
        sendJson(res, 200, { ok: true, product: ATLAS_PRODUCT, version: ATLAS_VERSION, ts: new Date().toISOString() });
      },
    },
    {
      method: 'GET', pattern: ['metrics'],
      handle: (_ctx, res) => {
        const body = metrics.render(store);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      },
    },

    // --- contribution -------------------------------------------------------
    {
      method: 'POST', pattern: ['v1', 'projects', ':projectId', 'notes'],
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        // A reader token is read-only by definition (section 14: Fleet never contributes).
        if (isReader(ctx.caller)) throw new HttpError(403, 'reader tokens cannot contribute notes');
        // An operator-authored note is an admin act: it lands promoted, and a contributor token that
        // could set `source: operator` would be a way to self-promote.
        const notes = (ctx.body as { notes?: unknown }).notes;
        if (!Array.isArray(notes)) throw new HttpError(400, 'body must be { notes: [...] }');
        if (notes.length === 0) { sendJson(res, 200, { results: [] }); return; }
        if (notes.length > config.maxBatch) throw new HttpError(413, `batch exceeds ATLAS_MAX_BATCH (${config.maxBatch})`);
        const idempotencyKey = header(ctx.headers, 'idempotency-key');
        if (!idempotencyKey) throw new HttpError(400, 'an Idempotency-Key header is required');
        const hasOperatorSource = (n: unknown): boolean =>
          (n as { provenance?: { source?: string } })?.provenance?.source === 'operator';
        const hasOverride = (n: unknown): boolean =>
          (n as { operatorOverride?: unknown })?.operatorOverride !== undefined;
        if (notes.some((n) => hasOperatorSource(n) || hasOverride(n)) && ctx.caller.class !== 'admin') {
          throw new HttpError(403, 'operator notes require an admin token');
        }
        // null, not 'admin': an admin is not bound to a host, and the note's own provenance is the only
        // attribution an operator note can carry. See NoteStore.contribute.
        const hostId = ctx.caller.class === 'admin' ? null : (ctx.caller as { hostId: string }).hostId;
        const results = store.contribute(projectId, hostId, notes, idempotencyKey, config.maxBatch);
        metrics.recordContribution(results);
        log.info('knowledge contribution received', { project: projectId, count: notes.length });
        sendJson(res, 200, { results });
      },
    },

    // --- reads --------------------------------------------------------------
    {
      method: 'GET', pattern: ['v1', 'projects', ':projectId', 'notes'], readOnly: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        const since = intParam(ctx.query.get('since'), 0);
        const tier = ctx.query.get('tier') === 'all' ? 'all' : 'promoted';
        const limit = Math.min(intParam(ctx.query.get('limit'), DEFAULT_FEED_LIMIT), MAX_FEED_LIMIT);
        sendJson(res, 200, store.feed(projectId, since, tier, {
          limit,
          ...(ctx.query.get('scope') ? { scope: ctx.query.get('scope')! } : {}),
          ...(ctx.query.get('kind') ? { kind: ctx.query.get('kind')! } : {}),
        }));
      },
    },
    {
      // Reader-facing counts (section 14). Deliberately a separate route from the notes feed rather than
      // a query parameter on it: the feed's job is to hand a host the notes it is missing, and bolting an
      // aggregate onto it would put a dashboard's read path on the same query as replication. It is
      // readOnly, so a reader token reaches it and a reader still cannot see a single claim.
      method: 'GET', pattern: ['v1', 'projects', ':projectId', 'summary'], readOnly: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        sendJson(res, 200, store.summary(projectId));
      },
    },
    {
      method: 'GET', pattern: ['v1', 'projects', ':projectId', 'bootstrap'],
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        if (isReader(ctx.caller)) throw new HttpError(403, 'bootstrap is for hosts, not readers');
        sendJson(res, 200, store.bootstrap(projectId));
      },
    },
    {
      method: 'GET', pattern: ['v1', 'projects', ':projectId', 'notes', ':noteId'], readOnly: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        const detail = store.getNote(projectId, ctx.params[1]!);
        if (!detail) throw new HttpError(404, 'no such note');
        sendJson(res, 200, detail);
      },
    },

    // --- curation -----------------------------------------------------------
    {
      method: 'POST', pattern: ['v1', 'projects', ':projectId', 'notes', ':noteId', 'promote'], admin: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        const reason = reasonFrom(ctx.body);
        let note;
        try {
          note = store.promote(projectId, ctx.params[1]!, 'admin', reason);
        } catch (err) {
          // A promotion that would put two live notes on one claim is a conflict the caller can resolve,
          // not a server fault: the message names the note to retire first.
          if (err instanceof ClaimConflictError) {
            throw new HttpError(409, err.message, 'claim-conflict', { conflictingNoteId: err.conflictingNoteId });
          }
          throw err;
        }
        if (!note) throw new HttpError(404, 'no such note');
        sendJson(res, 200, { note });
      },
    },
    {
      method: 'POST', pattern: ['v1', 'projects', ':projectId', 'notes', ':noteId', 'retire'], admin: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        const body = (ctx.body ?? {}) as { reason?: unknown; supersededBy?: unknown };
        const note = store.retire(projectId, ctx.params[1]!, 'admin', reasonFrom(ctx.body),
          typeof body.supersededBy === 'string' ? body.supersededBy : undefined);
        if (!note) throw new HttpError(404, 'no such note');
        sendJson(res, 200, { note });
      },
    },
    {
      // Deletion, and deliberately not a DELETE verb: this writes a sequence-bearing tombstone instead of
      // removing the row, and that difference is the whole of #590. The response is the tombstone itself,
      // so a caller can see with its own eyes that the claim is gone rather than taking it on trust.
      //
      // Admin-only, for the same reason promotion is. A contributor that could delete could erase a note
      // it disagrees with and take the argument off the table; section 12 settles disagreements by contest
      // and by retirement, both of which keep both notes readable.
      method: 'POST', pattern: ['v1', 'projects', ':projectId', 'notes', ':noteId', 'delete'], admin: true,
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        const note = store.deleteNote(projectId, ctx.params[1]!, 'admin', reasonFrom(ctx.body));
        if (!note) throw new HttpError(404, 'no such note');
        sendJson(res, 200, { note });
      },
    },
    {
      // A contributor may declare a conflict: an agent whose NOTES.md said one thing and whose code
      // said another is the best source of these. It still cannot promote, retire or delete.
      method: 'POST', pattern: ['v1', 'projects', ':projectId', 'notes', ':noteId', 'contest'],
      handle: (ctx, res) => {
        const projectId = ctx.params[0]!;
        requireProject(ctx.caller, projectId);
        if (isReader(ctx.caller)) throw new HttpError(403, 'reader tokens cannot contest notes');
        const contradicts = (ctx.body as { contradicts?: unknown })?.contradicts;
        if (typeof contradicts !== 'string' || contradicts === '') throw new HttpError(400, 'body must carry { contradicts: noteId }');
        const actor = ctx.caller.class === 'contributor' ? ctx.caller.hostId : 'admin';
        if (!store.contest(projectId, ctx.params[1]!, contradicts, actor)) throw new HttpError(404, 'no such note pair');
        sendJson(res, 200, { ok: true });
      },
    },

    // --- registries ---------------------------------------------------------
    {
      method: 'GET', pattern: ['v1', 'projects'], admin: true,
      handle: (_ctx, res) => sendJson(res, 200, { projects: store.listProjects() }),
    },
    {
      method: 'POST', pattern: ['v1', 'projects'], admin: true,
      handle: (ctx, res) => {
        const body = (ctx.body ?? {}) as { id?: unknown; name?: unknown; repoIdentities?: unknown; promotionPolicy?: unknown };
        if (typeof body.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.id)) {
          throw new HttpError(400, 'project id must be a lowercase slug');
        }
        if (typeof body.name !== 'string' || body.name === '') throw new HttpError(400, 'name is required');
        if (!Array.isArray(body.repoIdentities)) throw new HttpError(400, 'repoIdentities must be an array of normalized identities');
        if (store.getProject(body.id)) throw new HttpError(409, `project ${body.id} already exists`);
        sendJson(res, 201, store.createProject({
          id: body.id, name: body.name, repoIdentities: body.repoIdentities as string[],
          promotionPolicy: normalizePolicy(body.promotionPolicy),
        }));
      },
    },
    {
      method: 'GET', pattern: ['v1', 'projects', ':projectId'], admin: true,
      handle: (ctx, res) => {
        const project = store.getProject(ctx.params[0]!);
        if (!project) throw new HttpError(404, 'no such project');
        sendJson(res, 200, project);
      },
    },
    {
      method: 'PATCH', pattern: ['v1', 'projects', ':projectId'], admin: true,
      handle: (ctx, res) => {
        const body = (ctx.body ?? {}) as { name?: unknown; repoIdentities?: unknown; promotionPolicy?: unknown };
        const updated = store.updateProject(ctx.params[0]!, {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(Array.isArray(body.repoIdentities) ? { repoIdentities: body.repoIdentities as string[] } : {}),
          ...(body.promotionPolicy !== undefined ? { promotionPolicy: normalizePolicy(body.promotionPolicy) } : {}),
        });
        if (!updated) throw new HttpError(404, 'no such project');
        sendJson(res, 200, updated);
      },
    },
    {
      method: 'GET', pattern: ['v1', 'contributors'], admin: true,
      handle: (_ctx, res) => sendJson(res, 200, { contributors: store.listContributors() }),
    },
    {
      method: 'POST', pattern: ['v1', 'contributors'], admin: true,
      handle: (ctx, res) => {
        const body = (ctx.body ?? {}) as { token?: unknown; hostId?: unknown; projects?: unknown };
        if (typeof body.token !== 'string' || body.token.length < 16) {
          throw new HttpError(400, 'token must be a string of at least 16 characters');
        }
        if (typeof body.hostId !== 'string' || body.hostId === '') throw new HttpError(400, 'hostId is required');
        if (!Array.isArray(body.projects) || body.projects.length === 0) throw new HttpError(400, 'projects must be a non-empty array');
        // The plaintext token crosses the wire once, into the admin, and is never stored. The response
        // echoes the host binding rather than the token, so a token cannot be recovered from a log of
        // responses.
        store.addContributor(hashToken(body.token), body.hostId, body.projects as string[]);
        sendJson(res, 201, { hostId: body.hostId, projects: body.projects });
      },
    },
    {
      method: 'DELETE', pattern: ['v1', 'contributors', ':hostId'], admin: true,
      handle: (ctx, res) => {
        // Removal is by HOST, because that is what an operator knows. The table is keyed by token hash,
        // which nobody can read off a host's environment, so the store resolves host to hashes.
        const hostId = ctx.params[0]!;
        if (!store.listContributors().some((c) => c.hostId === hostId)) throw new HttpError(404, 'no such contributor');
        const removed = store.removeContributorByHost(hostId);
        sendJson(res, 200, { ok: true, removed });
      },
    },
  ];
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function intParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * A promotion policy, validated rather than stored as given.
 *
 * `null` is a meaningful value -- it disables auto-promotion for the project -- so "absent" and "null"
 * are different and both are accepted, while anything else is refused. Storing an unvalidated object
 * here would mean a typo in `minRuns` silently becoming "never promote".
 */
function normalizePolicy(raw: unknown): PromotionPolicy | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { auto: null };
  const auto = (raw as { auto?: unknown }).auto;
  if (auto === null) return { auto: null };
  const a = auto as { minRuns?: unknown; minDistinctHarnessesOrHosts?: unknown; kinds?: unknown };
  if (typeof a?.minRuns !== 'number' || !Number.isInteger(a.minRuns) || a.minRuns < 1) {
    throw new HttpError(400, 'promotionPolicy.auto.minRuns must be an integer >= 1');
  }
  if (typeof a.minDistinctHarnessesOrHosts !== 'number' || !Number.isInteger(a.minDistinctHarnessesOrHosts) || a.minDistinctHarnessesOrHosts < 1) {
    throw new HttpError(400, 'promotionPolicy.auto.minDistinctHarnessesOrHosts must be an integer >= 1');
  }
  if (a.kinds !== undefined && (!Array.isArray(a.kinds) || a.kinds.some((k) => typeof k !== 'string'))) {
    throw new HttpError(400, 'promotionPolicy.auto.kinds must be an array of note kinds');
  }
  return { auto: { minRuns: a.minRuns, minDistinctHarnessesOrHosts: a.minDistinctHarnessesOrHosts, kinds: (a.kinds as string[] | undefined) ?? [] } };
}

function reasonFrom(body: unknown): string {
  const reason = (body as { reason?: unknown })?.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    // Required, not defaulted. An unexplained promotion is unreconstructable at 3am, which is the same
    // argument crew/teams.md 7.1 makes about placement reasons.
    throw new HttpError(400, 'a reason is required');
  }
  return reason.trim();
}

export interface AtlasServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * Start Atlas. Returns once it is listening, so a caller (including a contract test) can hit it
 * immediately rather than racing the listen callback.
 */
export async function startAtlas(services: AtlasServices): Promise<AtlasServer> {
  const routes = buildRoutes(services);
  const { config, log } = services;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let url: URL;
    try {
      // Both of these can throw on input a client controls, and they run before authentication, so
      // anything outside this try is an unauthenticated way to make a request that is never answered.
      // `new URL` rejects a malformed authority; `matchRoute` decodes path segments.
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'the request target could not be parsed' });
      return;
    }
    let matched: { route: Route; params: string[] } | null;
    try {
      matched = matchRoute(routes, req.method ?? 'GET', url.pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    if (!matched) {
      sendJson(res, 404, { error: 'no such route' });
      return;
    }
    const { route, params } = matched;
    try {
      let caller: Caller | null = null;
      if (!route.public) {
        caller = authenticate(req, { callers: services.auth });
        if (!caller) throw new HttpError(401, 'a bearer token is required');
        if (route.admin && caller.class !== 'admin') throw new HttpError(403, 'this route requires an admin token');
      }
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readJsonBody(req) : {};
      // No body, no claim, no token. A request line is enough to see traffic and diagnose a host that
      // is retrying too hard.
      log.info('atlas request', { method: req.method, path: url.pathname, caller: caller?.class ?? 'public' });
      await route.handle({ caller: caller!, params, query: url.searchParams, headers: req.headers, body, log }, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.details === undefined ? { error: err.message, code: err.code } : { error: err.message, code: err.code, details: err.details });
        return;
      }
      // The message stays server-side. An unexpected throw can carry a fragment of the payload it was
      // parsing, and a 500 body goes to whoever sent the payload.
      log.error('atlas request failed', { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined });
      sendJson(res, 500, { error: 'internal error' });
    }
  };

  const server = config.tlsCert && config.tlsKey
    ? createHttpsServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler)
    : createHttpServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const scheme = config.tlsCert ? 'https' : 'http';
  // Started only once the socket is listening: a sweep that runs before the service is up would retire
  // notes against a database the operator may still be about to refuse to serve.
  const sweep = startMaintenanceSweep({ store: services.store, config, log });
  return {
    server,
    url: `${scheme}://${config.bindHost}:${port}`,
    close: () => {
      sweep.stop();
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
