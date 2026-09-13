import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Route-documentation coverage guard (issue #540).
 *
 * Extracts every router.<method>('<path>', ...) call from src/api/routes.ts and checks that
 * the path appears in at least one of the checked doc files. Fails when a route exists in code
 * but is mentioned in no doc.
 *
 * This is the inversion of the existing docs-contract check, which verifies that documented
 * things exist. This guard verifies that existing things are documented. Both are needed.
 */

const API_DIR = new URL('../src/api/', import.meta.url);
const ROUTES_SRC = readFileSync(new URL('../src/api/routes.ts', import.meta.url), 'utf8');

/**
 * Route files the coverage check deliberately does not read yet.
 *
 * `authRoutes.ts` registers `/login`, `/logout` and `/me`, none of which are documented. They are
 * pre-existing gaps, not part of issue #540, which is about the knowledge surfaces that shipped
 * undocumented. Listing the file here rather than widening the extractor keeps that decision visible:
 * the check below fails if a route-registering file appears that is neither covered nor listed, so the
 * set cannot grow silently the way `routes.ts` coverage did.
 */
const UNCOVERED_ROUTE_FILES = ['authRoutes.ts'];
const API_DOC    = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');
const GOALS_DOC  = readFileSync(new URL('../docs/goals.md', import.meta.url), 'utf8');

const ALL_DOC_TEXT = API_DOC + '\n' + GOALS_DOC;

/**
 * Extract route paths from the routes source.
 *
 * Matches lines like:
 *   router.get('/agents', ...)
 *   router.post('/runs/:runId/cancel', ...)
 *
 * Returns objects like { method: 'GET', path: '/api/agents' }.
 * The /api prefix is added because routes.ts defines them without it (mounted under /api).
 */
function extractRoutes(src: string): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  // Match: router.get('/path', or router.post('/path',
  // Using a character class for the quote so the pattern does not end at the escaped quote.
  const re = /router\.(get|post|put|patch|delete)\(['"]\/([^'"]*)['"]/gi;
  for (const m of src.matchAll(re)) {
    found.push({ method: m[1].toUpperCase(), path: `/api/${m[2]}` });
  }
  return found;
}

/**
 * Check whether a route path appears in the combined doc text.
 *
 * Two forms are accepted: the path exactly as the router declares it, and the same path with every
 * `:param` segment renamed to `:id`. The second exists because docs write `/api/runs/:id/goal` where
 * the code says `:runId`, and that difference is a naming preference rather than a missing route.
 *
 * What is deliberately NOT accepted is a match on the path with `/api` stripped. That fallback looked
 * harmless and was not: `/cancel` is a substring of the documented `/api/runs/:runId/cancel`, so an
 * undocumented `POST /api/cancel` was reported as documented and the guard passed. Every route in the
 * router matches one of the two forms above, so the fallback was not carrying any real case -- it was
 * only ever widening the net. A coverage check that reports green for a route nobody documented is the
 * exact defect #540 was filed about.
 */
function isDocumented(path: string, docText: string): boolean {
  if (docText.includes(path)) return true;
  if (docText.includes(path.replace(/:[^/]+/g, ':id'))) return true;
  return false;
}

test('every route in src/api/routes.ts appears in docs/api.md or docs/goals.md', () => {
  const routes = extractRoutes(ROUTES_SRC);
  assert.ok(routes.length >= 10,
    `expected at least 10 routes in routes.ts but found only ${routes.length}; check the extractor`);

  const undocumented = routes.filter(({ path }) => !isDocumented(path, ALL_DOC_TEXT));
  assert.deepEqual(
    undocumented.map(({ method, path }) => `${method} ${path}`),
    [],
    'Routes exist in src/api/routes.ts but are not mentioned in docs/api.md or docs/goals.md. '
    + 'Add documentation for each route listed above.',
  );
});

test('the guard can actually fire: a route with no doc entry is caught', () => {
  // Proven with a synthetic source that adds one undocumented route alongside the real ones.
  // Named with a word that already appears inside other documented paths, because that is the case
  // the guard has to survive: `/cancel` is a substring of the documented `/api/runs/:runId/cancel`, and
  // a looser matcher called this route documented.
  const fakeRoute = "router.post('/cancel', (req: Request, res: Response) => res.json({}));";
  const syntheticSrc = ROUTES_SRC + '\n' + fakeRoute;
  const routes = extractRoutes(syntheticSrc);
  const undoc = routes.filter(({ path }) => !isDocumented(path, ALL_DOC_TEXT));
  assert.ok(
    undoc.some(({ path }) => path === '/api/cancel'),
    'the guard must detect a route that appears in source but not in docs',
  );
});

test('the guard extractor finds the known routes', () => {
  const routes = extractRoutes(ROUTES_SRC);
  const paths = routes.map((r) => r.path);
  for (const expected of [
    '/api/agents',
    '/api/runs',
    '/api/knowledge/status',
    '/api/knowledge/notes',
    '/api/runs/:runId/knowledge',
  ]) {
    assert.ok(paths.includes(expected), `extractor missed expected route ${expected}`);
  }
});

test('no route-registering file escapes the guard silently', () => {
  // The failure this guards against is not "authRoutes is undocumented" -- that is known and listed.
  // It is a third file appearing, or routes being moved into an uncovered file, and the coverage check
  // going on reporting green because it only ever looked at routes.ts.
  const registering = readdirSync(API_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /router\.(get|post|put|patch|delete)\(/.test(readFileSync(new URL(f, API_DIR), 'utf8')))
    .sort();
  const covered = ['routes.ts'];
  const escaped = registering.filter((f) => !covered.includes(f) && !UNCOVERED_ROUTE_FILES.includes(f));
  assert.deepEqual(escaped, [], `route file(s) register endpoints but are neither covered by this guard nor listed as known-uncovered: ${escaped.join(', ')}`);
  // And the allowlist must not go stale in the other direction.
  const stale = UNCOVERED_ROUTE_FILES.filter((f) => !registering.includes(f));
  assert.deepEqual(stale, [], `UNCOVERED_ROUTE_FILES names file(s) that no longer register routes: ${stale.join(', ')}`);
});
