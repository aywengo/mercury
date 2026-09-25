// Bot credentials: the bot-side copy of the bot's API token (§4.2).
//
// The token necessarily exists twice: the server authorizes it from MERCURY_API_TOKENS (mercury.env),
// the bot presents it from bot-credentials.json. The file is per-host shared across bots — one JSON
// object keyed by alias — so a bot only ever reads its own entry and never sees the host's whole
// env file (which holds tokens for owners the bot has no business knowing).
//
// The 0600 gate mirrors client/credentials.ts and refuses rather than warns for the same reason:
// a group-readable token file is usually an accident, a warning scrolls past, and the token stays
// exposed. Only the permission BITS are examined, never ownership, and the check is skipped where
// mode bits are not meaningful (Windows).

import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function botCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'mercury', 'bot-credentials.json');
}

/** Same rule as the client: refuse anyone-but-owner readability; skip where bits are meaningless. */
export function assertBotCredentialsSafe(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    throw new Error(`cannot stat bot credentials file ${path}: ${(err as Error).message}`);
  }
  const groupOrWorldReadable = (mode & 0o077) !== 0;
  if (groupOrWorldReadable) {
    throw new Error(
      `refusing to read ${path}: it is readable by group or others (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). ` +
      'Run chmod 600 on it.',
    );
  }
}

export interface BotTokenPair {
  api?: string;
  llm?: string;
}

/**
 * Read the credentials file and return this alias's entry. Throws on missing file, bad JSON,
 * bad shape, or unsafe permissions. The token VALUE never appears in an error message.
 */
export function readBotCredentials(alias: string, env: NodeJS.ProcessEnv = process.env): BotTokenPair {
  const path = botCredentialsPath(env);
  assertBotCredentialsSafe(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: not valid JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object keyed by bot alias`);
  }
  const entry = (raw as Record<string, unknown>)[alias];
  if (entry === undefined) {
    throw new Error(`${path}: no entry for alias '${alias}'`);
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${path}: entry '${alias}' must be an object with an 'api' token field`);
  }
  const pair = entry as Record<string, unknown>;
  for (const key of Object.keys(pair)) {
    if (key !== 'api' && key !== 'llm') {
      const s = key === 'token' ? " (did you mean 'api'?)" : '';
      throw new Error(`${path}: entry '${alias}' has unknown key '${key}'${s}`);
    }
    if (typeof pair[key] !== 'string' || (pair[key] as string).trim() === '') {
      throw new Error(`${path}: entry '${alias}.${key}' must be a non-empty string`);
    }
    if ((pair[key] as string) !== (pair[key] as string).trim()) {
      // A padded token would present as ' tok-…' and read as drifted/unregistered, sending the
      // operator to check the wrong file. Name the field and the fix instead.
      throw new Error(`${path}: entry '${alias}.${key}' has leading or trailing whitespace; remove it (the file is read verbatim, not trimmed)`);
    }
  }
  if (typeof pair.api !== 'string') {
    throw new Error(`${path}: entry '${alias}.api' is required (the bot's Mercury API token)`);
  }
  return { api: pair.api, ...(pair.llm !== undefined ? { llm: pair.llm as string } : {}) };
}

/**
 * Parse the server-side token registry (MERCURY_API_TOKENS) far enough to find this bot's entry.
 * The parse rules are the strict ones B0-1 shipped (src/config.ts parseTokens): entries are
 * `<token>:<owner-id>` with exactly one colon.
 *
 * Returns the owner id whose token matches, or null when no registered token equals the bot's.
 */
export function registeredOwnerForToken(token: string, apiTokensRaw: string | undefined): string | null {
  if (apiTokensRaw === undefined || apiTokensRaw.trim() === '') return null;
  const entries = apiTokensRaw.split(',');
  for (let i = 0; i < entries.length; i++) {
    const trimmed = entries[i]!.trim();
    if (trimmed === '') continue;
    // Same strict shape loadConfig enforces (B0-1) — INCLUDING the failure: validate runs before
    // loadConfig(), and skipping a malformed entry would report 'not registered' for an env that
    // actually stops the host at boot. Fail with the same safe, index-based error (no token
    // value echoed) so the operator fixes the real problem.
    const parts = trimmed.split(':');
    if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
      const colons = (trimmed.match(/:/g) ?? []).length;
      const shape = colons === 0
        ? 'no colon separating token from owner'
        : colons === 1
          ? (parts[0]!.trim() ? 'empty owner half' : 'empty token half')
          : `${colons} colons (expected exactly one colon)`;
      throw new Error(
        `MERCURY_API_TOKENS entry ${i} must be exactly 'token:owner'; got an entry with ${shape}`,
      );
    }
    if (parts[0]!.trim() === token) return parts[1]!.trim();
  }
  return null;
}
