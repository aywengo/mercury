/** Fleet product id as reported by `--version` and `GET /healthz`. */
export const FLEET_PRODUCT = 'fleet';

/**
 * Fleet SemVer. Must equal `fleet/package.json` `"version"`.
 * `fleet/test/version.test.ts` asserts the two stay the same.
 */
export const FLEET_VERSION = '0.1.0';
