/** Host product id as reported by `--version` and `GET /healthz`. */
export const HOST_PRODUCT = 'host';

/**
 * Host SemVer. Must equal root `package.json` `"version"`.
 * `test/releaseHygiene.test.ts` asserts the two stay the same.
 */
export const HOST_VERSION = '0.1.1';

/**
 * Response-shape version of the routes Fleet depends on, reported as `api` on `GET /healthz`.
 *
 * This is NOT the host release version above, and the two must not be conflated: `version` moves on
 * every release whether or not anything Fleet reads changed, while `api` moves ONLY when a response
 * shape inside Fleet's call allowlist (fleet/child.ts) changes in a way an older Fleet would
 * misread. Bumping it on a cosmetic release would make Fleet refuse hosts it can serve perfectly.
 *
 * Fleet records the minimum it was written against and refuses a host below it at `hosts add` time,
 * so an old host paired with a new Fleet fails at registration instead of at first use.
 *
 * Bump to 2 when #508 changes the /api/agents shape.
 */
export const API_SCHEMA_VERSION = 1;
