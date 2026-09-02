/**
 * Child credentials, read from a file and referenced by name (docs/fleet-design.md section 9).
 *
 * Two rules drive this whole module. A credential is never a command-line argument, because argv is
 * world-readable through ps. And the file must not be readable by anyone but its owner, because Fleet
 * holds a credential for every Mercury it can reach -- one exposed file compromises the whole fleet.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export class CredentialError extends Error {}

export interface CredentialStore {
  /** Resolve a credential_ref to its secret. Throws when the name is unknown. */
  secret(ref: string): string;
  /** Names only. Safe to print; the values never are. */
  names(): string[];
  /**
   * The secret VALUES, for seeding the log redactor only.
   *
   * This exists because a pattern pass cannot recognise a bearer token it has no label for, and section
   * 15.5 requires the redactor to be seeded from the store. Nothing else may call it: no command prints
   * these, and `fleet credentials list` deliberately reports names only.
   */
  secrets(): string[];
}

/**
 * Reject any file whose mode grants access to group or other.
 *
 * Only the low nine permission bits are examined: the file mode also carries type bits (a socket or
 * symlink target would report them), and masking to 0o777 keeps the check about access rather than
 * file type.
 */
function assertPrivateMode(path: string, mode: number, allowInsecure: boolean): void {
  const access = mode & 0o777;
  if ((access & 0o077) === 0) return;
  const octal = access.toString(8).padStart(3, '0');
  const message =
    `credential file ${path} is mode ${octal}; group or other can read it. ` +
    `Fleet holds a credential for every Mercury it manages, so this file must be owner-only. ` +
    `Fix with: chmod 600 ${path}`;
  if (!allowInsecure) throw new CredentialError(message);
}

/**
 * Load the credential file.
 *
 * Shape is a flat JSON object of name -> secret. Anything else is refused rather than coerced: a nested
 * object would silently yield "[object Object]" as a bearer token and every probe would fail with 401,
 * which reads like a credential problem rather than the file-format problem it is.
 */
export function loadCredentials(path: string, allowInsecure = false): CredentialStore {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new CredentialError(
      `credential file ${path} not found. Create it as a JSON object of {"ref": "secret"} ` +
        `and chmod 600 it, or set FLEET_CREDENTIALS_FILE.`,
    );
  }
  assertPrivateMode(path, stat.mode, allowInsecure);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CredentialError(`cannot read credential file ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialError(`credential file ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialError(
      `credential file ${path} must contain a JSON object of {"ref": "secret"}; ` +
        `got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
    );
  }

  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new CredentialError(
        `credential "${key}" in ${basename(path)} is ${value === null ? 'null' : typeof value}, ` +
          `not a string. A non-string would be sent as a bearer token and rejected with 401.`,
      );
    }
    if (value.length === 0) {
      throw new CredentialError(`credential "${key}" in ${basename(path)} is empty`);
    }
    map.set(key, value);
  }

  return {
    secret(ref: string): string {
      const found = map.get(ref);
      if (found === undefined) {
        // Names only in the message. Listing values would put secrets in logs and terminal scrollback.
        const known = [...map.keys()].sort().join(', ') || '(none)';
        throw new CredentialError(`unknown credential ref "${ref}"; known refs: ${known}`);
      }
      return found;
    },
    names(): string[] {
      return [...map.keys()].sort();
    },
    secrets(): string[] {
      return [...map.values()];
    },
  };
}
