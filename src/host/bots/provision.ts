// Provisioning a dispatcher bot from `mercury host setup` (docs/dispatcher-bot-design.md §11;
// B4, issue #915).
//
// The wizard's bots step writes the two files a scheduler-only bot needs, in one pass:
//
//   - `<alias>.json` in the bots directory — a starter schedule the operator edits;
//   - the alias's `api` token in the shared 0600 `bot-credentials.json`;
//   - the matching `token:bot-<alias>` entry in the server's `MERCURY_API_TOKENS` (the wizard
//     renders it into mercury.env, so both copies are written by one run and cannot drift at
//     creation — §4.2).
//
// Three rules this file exists to enforce:
//
// 1. **Nothing is overwritten silently.** An existing `<alias>.json` is kept, and the summary says
//    so (the #250 lesson: name what would be lost). A token that already exists in one copy is
//    reused, never rotated behind the operator's back; two copies that already disagree are
//    refused by name, because "write both" cannot pick a winner.
// 2. **The token value is never printed.** Plans and summaries carry its length only.
// 3. **Postures the tree cannot run are refused, not faked.** Observer and brain configs land with
//    B2/B3 (#907–#909, #912); the §8.5 blast-radius sentence is printed before that refusal so the
//    operator sees the trade-off they would be accepting.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BOT_ALIAS_RE, botConfigPath, botsDir } from './config.ts';
import { apiTokenForOwner, botCredentialsPath, readBotCredentialsEntry, upsertBotTokenInApiTokens, type BotTokenPair } from './credentials.ts';
import { botOwnerId } from './keys.ts';

/** The postures §11's step can describe. Only `scheduler` is runnable before B2/B3. */
export const BOT_POSTURES = ['scheduler', 'observer', 'brain'] as const;
export type BotPosture = (typeof BOT_POSTURES)[number];

/**
 * The §8.5 blast-radius sentence, verbatim. `host setup` prints it before an observer or brain
 * posture would be enabled; `test/botsDocs.test.ts` pins this copy against the design doc so the
 * two cannot drift.
 */
export const BLAST_RADIUS_SENTENCE =
  'An operator enabling the observer scope plus a brain is accepting that a hostile Run on this host can influence which declared template the bot dispatches and how it answers its own Runs.';

/** The starter schedule: one daily task at 03:00 UTC. */
export const STARTER_TASK_NAME = 'maintenance';
export const STARTER_CRON = '0 3 * * *';

export const DEFAULT_BOT_ALIAS = 'maint';

/** A fresh bot token in the §4.2 shape the redactor and the API already handle (`tok-`). */
export function generateBotToken(alias: string): string {
  if (!BOT_ALIAS_RE.test(alias)) {
    throw new Error(`bot alias must match ${BOT_ALIAS_RE.source}, got '${alias}'`);
  }
  return `tok-bot-${alias}-${randomBytes(16).toString('hex')}`;
}

/**
 * The starter config the wizard writes. It must pass `loadBotConfig` unchanged (the wizard may not
 * write a config `host bot validate` would reject), so it uses only the v1 scheduler fields.
 */
export function starterBotConfig(alias: string, harness: string): Record<string, unknown> {
  if (!BOT_ALIAS_RE.test(alias)) {
    throw new Error(`bot alias must match ${BOT_ALIAS_RE.source}, got '${alias}'`);
  }
  return {
    description:
      `Scheduler-only dispatcher bot created by \`mercury host setup\` (B4). Edit the tasks below; ` +
      `\`mercury host bot validate --alias ${alias}\` checks the file.`,
    schedule: {
      tasks: [
        {
          name: STARTER_TASK_NAME,
          cron: STARTER_CRON,
          tz: 'UTC',
          singleFlight: true,
          onMiss: 'skip',
          template: {
            task:
              'Daily maintenance for {{fire.date}}: review this host\'s recent Runs for failures that need attention ' +
              'and report what you found. Do not modify files outside the workspace.',
            agent: harness,
            constraints: { maxDurationMs: 3_600_000, maxRetries: 0 },
          },
        },
      ],
    },
  };
}

export interface BotProvisionInput {
  alias: string;
  harness: string;
  posture: BotPosture;
  env: NodeJS.ProcessEnv;
  /** The MERCURY_API_TOKENS value the wizard is about to write (file value, else process env). */
  apiTokensRaw: string | undefined;
  /** Test seam for the credentials entry; default reads the real file (0600-checked). */
  credentials?: BotTokenPair;
  /** Test seam for "a config already exists"; default stats the bots directory. */
  configExists?: boolean;
}

export interface BotProvisionPlan {
  alias: string;
  owner: string;
  posture: BotPosture;
  token: string;
  /** Where the token came from: generated now, the credentials copy, or the env registry. */
  tokenSource: 'generated' | 'credentials' | 'env';
  configPath: string;
  configAction: 'write' | 'keep';
  config: Record<string, unknown>;
  credentialsPath: string;
  /** 'write' when the alias has no credentials entry yet; an existing one is left unchanged. */
  credentialsAction: 'write' | 'unchanged';
  /** The full MERCURY_API_TOKENS value the wizard must write. */
  apiTokensValue: string;
}

/**
 * Decide what the bots step would do, without writing anything. Throws (with a named cause and no
 * token value) when the two existing copies already disagree.
 */
export function planBotProvision(input: BotProvisionInput): BotProvisionPlan {
  const { alias, harness, posture, env } = input;
  if (!BOT_ALIAS_RE.test(alias)) {
    throw new Error(`bot alias must match ${BOT_ALIAS_RE.source}, got '${alias}'`);
  }
  const owner = botOwnerId(alias);
  const credentialsPath = botCredentialsPath(env);
  const credentials = input.credentials !== undefined
    ? input.credentials
    : existsSync(credentialsPath)
      ? readBotCredentialsEntry(alias, env)
      : undefined;
  const credentialToken = credentials?.api;
  const envToken = apiTokenForOwner(input.apiTokensRaw, owner) ?? undefined;

  if (credentialToken !== undefined && envToken !== undefined && credentialToken !== envToken) {
    throw new Error(
      `bot '${alias}': ${credentialsPath} and MERCURY_API_TOKENS hold different tokens for ${owner}. ` +
      `Setup writes both copies in one step and cannot pick a winner; remove the '${alias}' entry from one file ` +
      '(or uninstall the bot) and re-run so both copies are written together.',
    );
  }
  const token = credentialToken ?? envToken ?? generateBotToken(alias);
  const tokenSource: BotProvisionPlan['tokenSource'] =
    credentialToken !== undefined ? 'credentials' : envToken !== undefined ? 'env' : 'generated';
  const configPath = botConfigPath(alias, env);
  const configExists = input.configExists ?? existsSync(configPath);
  return {
    alias,
    owner,
    posture,
    token,
    tokenSource,
    configPath,
    configAction: configExists ? 'keep' : 'write',
    config: starterBotConfig(alias, harness),
    credentialsPath,
    credentialsAction: credentialToken === token ? 'unchanged' : 'write',
    apiTokensValue: upsertBotTokenInApiTokens(input.apiTokensRaw, alias, token),
  };
}

/**
 * Write the bot files for a plan: the starter config (never over an existing file) and the alias's
 * credentials entry, preserving every other alias. Both files are 0600. The caller writes
 * mercury.env with `plan.apiTokensValue` — the server-side copy.
 */
export function writeBotProvision(plan: BotProvisionPlan, env: NodeJS.ProcessEnv): void {
  mkdirSync(botsDir(env), { recursive: true });
  if (plan.configAction === 'write') {
    // 'wx': if a config appeared between planning and writing, fail rather than clobber it.
    writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (plan.credentialsAction === 'write') {
    let existing: Record<string, unknown> = {};
    if (existsSync(plan.credentialsPath)) {
      const raw: unknown = JSON.parse(readFileSync(plan.credentialsPath, 'utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${plan.credentialsPath}: must be a JSON object keyed by bot alias`);
      }
      existing = raw as Record<string, unknown>;
    }
    // The alias entry is absent (or the file is new) whenever this branch runs: an existing entry
    // would have supplied `plan.token` and been left unchanged. Other aliases are preserved.
    // Atomic (temp + fsync + rename, created 0600): an in-place rewrite that crashed mid-write would
    // truncate the file and lose every OTHER alias's credentials, and on an existing file the
    // contents would land before the mode was repaired.
    writeFileAtomic0600(plan.credentialsPath, JSON.stringify({ ...existing, [plan.alias]: { api: plan.token } }, null, 2) + '\n');
  }
}

/** Write `content` to `path` atomically with mode 0600: a temp file in the same directory, fsync,
 *  rename. A crash leaves either the old file or the new one, never a truncated one. */
export function writeFileAtomic0600(path: string, content: string): void {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** A redacted, operator-facing summary of the bots step. Never includes the token value. */
export function botProvisionSummary(plan: BotProvisionPlan): string {
  const config = plan.configAction === 'write'
    ? `config: write ${plan.configPath}`
    : `config: keep ${plan.configPath} (existing file not overwritten)`;
  return [
    `bot: ${plan.alias} (owner ${plan.owner}, posture ${plan.posture})`,
    `  ${config}`,
    `  credentials: ${plan.credentialsAction === 'write' ? 'write' : 'unchanged'} ${plan.credentialsPath}`,
    `  api token: <set, ${plan.token.length} chars> (${plan.tokenSource})`,
    `  MERCURY_API_TOKENS: ${plan.owner} registered`,
  ].join('\n');
}
