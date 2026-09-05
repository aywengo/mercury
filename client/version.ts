import { readFileSync } from 'node:fs';

/**
 * The program's identity: its name and its version, in one place.
 *
 * The version is read from the package manifest rather than repeated here. It was previously written
 * twice -- `package.json` said `0.1.0` while the `User-Agent` said `0.1` -- and nothing failed, because
 * the two strings are never compared. A server that logs the User-Agent would record a version that
 * no artifact has ever had, which is exactly the kind of detail you only notice while debugging a
 * report from a machine you cannot reach.
 *
 * Reading the manifest at runtime is also what makes `--version` honest after an install: the value
 * comes from the manifest that was installed alongside this code, so a stale build cannot claim a
 * version it does not have.
 */
export const PROGRAM = 'mercuryctl';

interface Manifest { name?: unknown; version?: unknown }

function readManifest(): Manifest {
  try {
    // Resolved relative to this module, not the process working directory: the CLI is routinely run
    // from wherever the operator happens to be standing.
    const url = new URL('../package.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8')) as Manifest;
  } catch {
    // A missing manifest must not take the CLI down. `--version` reporting an unknown version is
    // strictly better than a tool that cannot print help.
    return {};
  }
}

const manifest = readManifest();

function valid(value: unknown): string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : '0.0.0-dev';
}

/** Semver of this client, from the installed manifest. */
export const CLIENT_VERSION: string = valid(manifest.version);

/**
 * Non-secret client identity (§14). Derived from CLIENT_VERSION so the two cannot disagree, and
 * deliberately free of anything identifying the operator or the host.
 */
export const USER_AGENT = `${PROGRAM}/${CLIENT_VERSION}`;
