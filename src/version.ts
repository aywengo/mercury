/** Host product id as reported by `--version` and `GET /healthz`. */
export const HOST_PRODUCT = 'host';

/**
 * Host SemVer. Must equal root `package.json` `"version"`.
 * `test/releaseHygiene.test.ts` asserts the two stay the same.
 */
export const HOST_VERSION = '0.1.0';
