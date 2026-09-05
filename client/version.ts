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

/** The manifest this client belongs to. Guards against reading a dependency's manifest. */
const MANIFEST_NAME = '@aywengo/mercury';

interface Manifest { name?: unknown; version?: unknown }

function readManifest(): Manifest {
  // Walk up from this module rather than hard-coding a relative depth. The published layout is not the
  // source layout: this file is client/version.ts in the repository and dist/client/version.js in the
  // published artifact, so '../package.json' is correct in one and silently wrong in the other. The
  // failure is silent by construction -- the catch below returns {} and the CLI reports 0.0.0-dev,
  // which is exactly the kind of wrong-but-plausible version that makes a bug report untrustworthy.
  let dir = new URL('.', import.meta.url);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const candidate = new URL('package.json', dir);
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Manifest & { name?: unknown };
      // Match on the name, not merely on "a package.json exists": a dependency could otherwise supply
      // its own manifest and the CLI would report someone else's version.
      if (parsed.name === MANIFEST_NAME) return parsed;
    } catch {
      // keep walking
    }
    const parent = new URL('..', dir);
    if (parent.href === dir.href) break;
    dir = parent;
  }
  // A missing manifest must not take the CLI down. `--version` reporting an unknown version is strictly
  // better than a tool that cannot print help.
  return {};
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
