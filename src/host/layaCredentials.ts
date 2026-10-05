// The Laya sidecar's API key (design §5.1, #831): its OWN 0600 file, laya-credentials.json,
// beside bot-credentials.json -- never an entry in that shared, alias-keyed file.
//
// The first implementation stored the key as the `laya` entry of bot-credentials.json. That put
// the sidecar in the bot-alias namespace: `laya` became a reserved alias, and every bot
// lifecycle path (install, uninstall, reassign, setup) needed heuristics to tell a legacy bot
// named `laya` from the sidecar credential (#840 r29-r62). A separate file has no namespace to
// collide with, so `laya` is an ordinary bot alias again.
//
// Shape: { "api": "<key>" }. The 0600 gate, the "never echo a value" rule and the error wording
// follow bots/credentials.ts so the doctor, setup and (later) bots refuse the same files the
// same way.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertBotCredentialsSafe } from './bots/credentials.ts';

/** Characters a key may contain: it is embedded in a launchd plist (XML) and a systemd unit,
 *  where whitespace, quotes, ampersands or newlines would corrupt the file or inject a
 *  directive (Copilot #840 r5). Wizard-generated keys are 64 hex chars. */
export const LAYA_KEY_RE = /^[A-Za-z0-9._~@:+/=-]+$/;

export function layaCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'mercury', 'laya-credentials.json');
}

/** Parse and validate an existing file. Errors name the file and the field, never a value. */
function parseLayaCredentials(path: string): { api: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Node's parse error quotes a source excerpt; with the key near the malformation that
    // excerpt would leak it through any caller that prints the message (Copilot #840 r2).
    throw new Error(`${path}: not valid JSON (${(err as Error).name ?? 'SyntaxError'})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object with an 'api' field`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'api') {
      const hint = key === 'token' ? " (did you mean 'api'?)" : '';
      throw new Error(`${path}: unknown key '${key}'${hint}`);
    }
  }
  const api = obj.api;
  if (api === undefined) {
    throw new Error(`${path}: 'api' is required (the sidecar's LAYA_API_KEY)`);
  }
  if (typeof api !== 'string' || api.trim() === '') {
    throw new Error(`${path}: 'api' must be a non-empty string`);
  }
  if (api !== api.trim()) {
    throw new Error(`${path}: 'api' has leading or trailing whitespace; remove it (the file is read verbatim, not trimmed)`);
  }
  if (!LAYA_KEY_RE.test(api)) {
    throw new Error(
      `${path}: 'api' contains characters that cannot be embedded in the service unit; ` +
      'use a key of [A-Za-z0-9._~@:+/=-] only (the wizard generates 64 hex chars)',
    );
  }
  return { api };
}

/**
 * The sidecar key, for the doctor and setup's verify probes. Throws on a missing file, unsafe
 * permissions (0600 gate, refuses rather than repairs -- a reader must not change modes), bad
 * JSON or bad shape. The key never appears in an error message.
 */
export function readLayaCredentials(env: NodeJS.ProcessEnv = process.env): { api: string } {
  const path = layaCredentialsPath(env);
  if (!existsSync(path)) {
    throw new Error(`no laya credentials (${path} does not exist)`);
  }
  assertBotCredentialsSafe(path);
  return parseLayaCredentials(path);
}

/**
 * Setup's write path (#831 acceptance): PRESERVE an existing key on a re-run, generate one
 * (32 random bytes, hex) when absent. An existing file's mode is repaired to 0600 BEFORE it is
 * validated (Copilot #840 r1/r3); a malformed existing file is refused, never overwritten.
 */
export function ensureLayaCredentials(
  env: NodeJS.ProcessEnv = process.env,
  gen: () => string = () => randomBytes(32).toString('hex'),
): { key: string; generated: boolean } {
  const path = layaCredentialsPath(env);
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return { key: parseLayaCredentials(path).api, generated: false };
  }
  const key = gen();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic create (Copilot #840 r14/r52): a unique temp opened exclusively at 0600 ('wx' --
  // `mode` only applies at creation, so a stale same-named leftover must never be reused),
  // fsync, rename over the destination, then enforce 0600.
  const tmp = join(dirname(path), `.laya-credentials.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify({ api: key }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  // Best-effort cleanup of a crashed run's predictable same-pid temp -- ours to remove.
  rmSync(join(dirname(path), `.laya-credentials.json.tmp-${process.pid}`), { recursive: true, force: true });
  return { key, generated: true };
}
