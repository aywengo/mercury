/**
 * The Atlas read client (docs/knowledge-base.md section 14).
 *
 * Fleet reads Atlas and nothing more. It never contributes, promotes, retires or deletes: the token it
 * is configured with is a READER token, and this module exposes no method that could use anything else.
 * That is a property of the token rather than of this file -- a reader cannot write even if this module
 * grew a POST -- but keeping only reads here is what makes the property visible to a reviewer.
 *
 * The response types are redeclared rather than imported from `atlas/`. Section 14 makes the product
 * independence symmetric, and `fleet/package.json` publishes without the Atlas tree, so an import would
 * turn a documentation promise into a build dependency. The cost of duplicating a shape is drift, and
 * `test/atlasContract.test.ts` pays for it by asserting both sides against the same fixture.
 */

/** Mirrors `ProjectSummary` in `atlas/notes.ts`. Kept in sync by test/atlasContract.test.ts. */
export interface AtlasProjectSummary {
  projectId: string;
  byTier: Record<string, number>;
  promotedByKind: Record<string, number>;
  contestedPairs: number;
  contributors: { hostId: string; notes: number; lastArrival: string }[];
  latestSeq: number;
}

/**
 * The same key set as a VALUE, so a test can compare it against bytes off the wire.
 *
 * The type alone cannot do this. Mutual assignability between two interfaces tolerates a field that is
 * optional on one side and absent on the other -- a review proved that by mutation -- and an optional
 * field is exactly how a dashboard ends up reading `undefined` and rendering an empty panel. So the key
 * set is declared here as a const tuple, pinned to the interface at compile time below, and compared
 * against Atlas's actual response at runtime. A field added to the interface without joining the tuple
 * fails `tsc`; a tuple entry Atlas stops sending fails the contract test.
 */
export const ATLAS_SUMMARY_KEYS = [
  'projectId', 'byTier', 'promotedByKind', 'contestedPairs', 'contributors', 'latestSeq',
] as const satisfies readonly (keyof AtlasProjectSummary)[];

/** Compile-time proof the tuple covers every key, not just some of them. */
const _keysAreExhaustive: typeof ATLAS_SUMMARY_KEYS[number] | Exclude<keyof AtlasProjectSummary, typeof ATLAS_SUMMARY_KEYS[number]> extends never
  ? never
  : (Exclude<keyof AtlasProjectSummary, typeof ATLAS_SUMMARY_KEYS[number]> extends never ? true : never) = true;
void _keysAreExhaustive;

export interface AtlasReaderOptions {
  baseUrl: string;
  token: string;
  project: string;
  timeoutMs: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A read that did not produce a value, split by who can fix it.
 *
 * Collapsing these into one "failed" boolean was the obvious simplification and it costs an operator an
 * afternoon. `unreachable` means Atlas did not answer -- it is restarting, or the network is -- and the
 * dashboard should keep showing the last good numbers. `rejected` means Atlas answered and said no, which
 * is a misconfiguration here: a revoked token, a project this token is not bound to. Retrying that forever
 * is wrong, and "Atlas is down" is the wrong thing to tell someone whose typo caused it.
 */
export type AtlasRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'rejected'; status: number; detail: string };

function describeTransportError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const detail = e.cause?.code ?? e.cause?.message;
  return `${e.message}${detail ? `: ${detail}` : ''}`.slice(0, 200);
}

/**
 * `GET /v1/projects/:project/summary` with a bearer reader token.
 *
 * The timeout is per request and aborts rather than queues. Fleet's own API must not become as slow as
 * the slowest thing it decorates a response with: a dashboard section is worth less than the page it is
 * embedded in, so an Atlas that stops answering has to be able to cost a bounded number of milliseconds.
 */
export async function readProjectSummary(opts: AtlasReaderOptions): Promise<AtlasRead<AtlasProjectSummary>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl}/v1/projects/${encodeURIComponent(opts.project)}/summary`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { kind: 'unreachable', reason: describeTransportError(err) };
  }
  if (res.status >= 500) return { kind: 'unreachable', reason: `HTTP ${res.status} from Atlas` };
  // 408 and 429 are the two 4xx that are not a refusal. They mean "I received it and could not answer
  // just now", so treating them like a bad token would tell an operator to go change a configuration
  // that is fine, and would stop a retry that would have worked.
  if (res.status === 408 || res.status === 429) {
    return { kind: 'unreachable', reason: `HTTP ${res.status} from Atlas` };
  }
  if (res.status >= 400) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch { /* a non-JSON error body still carries a status worth reporting */ }
    return { kind: 'rejected', status: res.status, detail: detail.slice(0, 300) };
  }
  try {
    return { kind: 'ok', value: await res.json() as AtlasProjectSummary };
  } catch (err) {
    // 200 with an unreadable body is neither: Atlas is up and its answer is unusable, which the operator
    // reads as "Atlas is misbehaving", so it is reported that way rather than as a transport failure.
    // Wording deliberately does not say "was not JSON". A stalled body stream lands here too, and the
    // abort error would then be reported as a format problem.
    return { kind: 'unreachable', reason: `Atlas response body was unreadable: ${(err as Error).message}`.slice(0, 200) };
  }
}


/**
 * What Fleet's own API reports about Atlas, and the only shape the dashboard sees.
 *
 * `configured: false` is not an error and not empty data. Section 14 makes an unconfigured Atlas a
 * fully supported steady state -- no knowledge section, placement unchanged -- and the UI needs to tell
 * "this Fleet does not read Atlas" apart from "Atlas is down", because only one of them belongs on an
 * operator's screen as a problem.
 */
export type AtlasView =
  | { configured: false }
  | { configured: true; state: 'ok'; project: string; summary: AtlasProjectSummary; fetchedAt: string; stale: false }
  | { configured: true; state: 'unreachable'; project: string; reason: string; stale: false }
  | { configured: true; state: 'rejected'; project: string; status: number; detail: string; stale: false }
  | { configured: true; state: 'unreachable' | 'rejected'; project: string; reason: string;
      summary: AtlasProjectSummary; fetchedAt: string; stale: true };

export interface AtlasReader {
  /** Reads through the cache policy below. Never throws: every failure becomes an AtlasView. */
  view(): Promise<AtlasView>;
}

/**
 * A reader that keeps the last good summary.
 *
 * The cache exists for two reasons, and only the second is obvious. A dashboard polls, and without a
 * floor on the request rate a page refresh loop becomes a load generator pointed at Atlas. The first is
 * the reason it stores the VALUE rather than just a timestamp: section 14 says a stale replica is a
 * reason to prefer one host over another, and "the last numbers we have, from 4 minutes ago" is a
 * strictly more useful dashboard than a blank panel during an Atlas restart -- as long as it is
 * labelled, which is what `stale` is for. An unlabelled stale number is worse than no number, because
 * it reads as current.
 */
export function createAtlasReader(
  opts: AtlasReaderOptions & { cacheMs?: number; now?: () => number },
): AtlasReader {
  const cacheMs = opts.cacheMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  let cached: { summary: AtlasProjectSummary; fetchedAt: number } | null = null;

  async function fresh(): Promise<AtlasRead<AtlasProjectSummary>> {
    return readProjectSummary(opts);
  }

  return {
    async view(): Promise<AtlasView> {
      // The rate floor the type comment above promises. Without it a dashboard on a 2-second refresh
      // turns every open browser tab into a load generator pointed at Atlas, and Atlas is a shared
      // service while the dashboard is not.
      if (cached && now() - cached.fetchedAt < cacheMs) {
        return {
          configured: true, state: 'ok', project: opts.project,
          summary: cached.summary, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: false,
        };
      }
      const read = await fresh();
      if (read.kind === 'ok') {
        cached = { summary: read.value, fetchedAt: now() };
        return {
          configured: true, state: 'ok', project: opts.project,
          summary: read.value, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: false,
        };
      }
      const reason = read.kind === 'unreachable' ? read.reason : `HTTP ${read.status}: ${read.detail}`;
      if (cached) {
        // Serve the last good numbers, labelled stale. The failure is reported alongside them rather
        // than instead of them, so the panel cannot silently freeze at an old value.
        return {
          configured: true, state: read.kind, project: opts.project, reason,
          summary: cached.summary, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true,
        };
      }
      if (read.kind === 'rejected') {
        return { configured: true, state: 'rejected', project: opts.project, status: read.status, detail: read.detail, stale: false };
      }
      return { configured: true, state: 'unreachable', project: opts.project, reason, stale: false };
    },
  };
}
