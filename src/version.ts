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
 * Both halves of that rule are enforced by `test/apiSchemaVersion.test.ts` against
 * `test/fixtures/api-shapes.json`, which records the shape of every endpoint Fleet reads:
 *
 *   * rename or retype a field Fleet reads and the live-shape check fails, telling you to bump;
 *   * bump without a recorded BREAKING difference and the version-chain check fails, telling you
 *     to put it back -- which is the half that matters most, because a bump on a cosmetic release
 *     makes older Fleets refuse hosts they can serve perfectly.
 *
 * Additive is not breaking. #508 added `capabilities` to `/api/agents` and correctly left this at 1:
 * an older Fleet ignores a key it has never heard of. A bump for that would have been the outage.
 *
 * So there is no standing instruction here to bump for a named future change. Move this number only
 * when the guard tells you the shapes Fleet reads genuinely broke, and raise `MIN_HOST_API` in
 * `fleet/probe.ts` in the same step.
 */
export const API_SCHEMA_VERSION = 1;
