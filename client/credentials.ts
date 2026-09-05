// Credential storage and its permission gate (docs/cli-tui-design.md §9.1, §13).
//
// The credential this client holds can create paid work and control every Run visible to its owner,
// so it is stored apart from profile configuration and its file mode is enforced rather than
// merely recommended.
//
// Why refuse instead of warn: a group-readable token file is usually an accident (a shared dotfile
// repo, a copied config, a umask of 022 on a multi-user box). A warning scrolls past once and the
// token stays exposed; a hard failure forces the one-line fix. The escape hatch is to chmod the
// file, which is exactly the action we want to make unavoidable.
//
// There is deliberately no token option on the command line anywhere in this client. argv is
// readable by any local process via `ps` and is retained in shell history, so a --token flag would
// put the credential in two places the operator does not control.

import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './api/errors.ts';

export interface CredentialSource {
  token: string;
  /** Where it came from, for diagnostics. Never contains the value. */
  origin: 'env' | 'file';
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'mercury');
  return join(homedir(), '.config', 'mercury');
}

export function credentialsPath(dir = configDir()): string {
  return join(dir, 'credentials.json');
}

/**
 * Reject a credentials file that is readable by anyone other than its owner.
 *
 * Only the permission BITS are examined, never ownership: checking st_uid would break the legitimate
 * case of a root-managed file an operator reads through a group, and would pass a file the operator
 * does not own but has locked down correctly.
 *
 * On platforms where the mode bits are not meaningful (Windows) the check is skipped rather than
 * guessed at -- failing there would make the client unusable for its main audience, and a fake check
 * that always passes is worse than an absent one because it advertises protection that does not exist.
 */
export function assertCredentialFileSafe(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    // Absent is handled by the caller's read; a stat failure that is not ENOENT (a bad path in the
    // middle of a mount, for instance) must not be reported as a permission problem.
    throw new UsageError(`cannot read credential file ${path}: ${(err as Error).message}`);
  }
  const groupOrWorldReadable = (mode & 0o077) !== 0;
  if (groupOrWorldReadable) {
    throw new UsageError(
      `refusing to read ${path}: it is readable by group or others (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). ` +
      'Run chmod 600 on it, or store the token in MERCURY_CLIENT_TOKEN instead.',
    );
  }
}

/**
 * Resolve the bearer token: environment first, then the profile's credential reference.
 *
 * The env var wins so CI can inject a credential without writing a file to disk, and so an operator
 * can point one invocation at a different endpoint without editing shared config.
 *
 * The returned value must only ever be handed to the HTTP transport. It must never be interpolated
 * into an error message, a log line or a diagnostic object -- callers that print `err.message` get
 * the strings above, which name the file and the variable but never the secret.
 */
export function resolveCredential(options: {
  credentialName?: string;
  env?: NodeJS.ProcessEnv;
  dir?: string;
  platform?: NodeJS.Platform;
}): CredentialSource {
  const env = options.env ?? process.env;
  const fromEnv = env.MERCURY_CLIENT_TOKEN;
  if (fromEnv && fromEnv.trim() !== '') {
    return { token: fromEnv, origin: 'env' };
  }

  const name = options.credentialName;
  if (!name) {
    throw new UsageError(
      'no credential configured. Set MERCURY_CLIENT_TOKEN, or name a credential in the profile and ' +
      'store its value in the credentials file.',
    );
  }

  const path = credentialsPath(options.dir);
  assertCredentialFileSafe(path, options.platform);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read credential file ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`credential file ${path} must contain a JSON object of name to token`);
  }
  const value = (parsed as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`credential ${JSON.stringify(name)} is not present in ${path}`);
  }
  return { token: value, origin: 'file' };
}

/**
 * Strip anything that looks like a bearer credential from a string destined for stderr.
 *
 * This is a backstop, not the primary control: the transport adds the header and nothing else should
 * ever see the token. It exists because an undici or fetch error can echo request details, and one
 * leaked Authorization header in a CI log is a revoked token.
 */
export function redactAuthorization(text: string): string {
  return text
    .replace(/(authorization\s*:\s*)bearer\s+\S+/gi, '$1[redacted]')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]');
}
