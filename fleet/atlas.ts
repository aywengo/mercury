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
    return { kind: 'unreachable', reason: `Atlas response was not JSON: ${(err as Error).message}`.slice(0, 200) };
  }
}
