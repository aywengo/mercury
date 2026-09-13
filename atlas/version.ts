/** Atlas product id as reported by `--version` and `GET /healthz`. */
export const ATLAS_PRODUCT = 'atlas';

/**
 * Atlas SemVer. Must equal `atlas/package.json` `"version"`.
 * `atlas/test/version.test.ts` asserts the two stay the same.
 */
export const ATLAS_VERSION = '0.1.0';
