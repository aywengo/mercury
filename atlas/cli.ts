#!/usr/bin/env node
/**
 * The Atlas command (docs/knowledge-base.md section 15).
 *
 * `atlas serve` is the only command that matters in production; the rest exist so an operator can
 * prepare a registry before the first host points at the service, and diagnose one afterwards without
 * reaching for a SQLite prompt.
 */

import { randomBytes } from 'node:crypto';
import { openDatabase } from './db.ts';
import { loadAtlasConfig } from './config.ts';
import { createRedactor } from './redact.ts';
import { createLogger } from './logger.ts';
import { AuthIndex, hashToken, seedContributors } from './auth.ts';
import { AtlasMetrics } from './metrics.ts';
import { NoteStore } from './notes.ts';
import { startAtlas } from './server.ts';
import { ATLAS_PRODUCT, ATLAS_VERSION } from './version.ts';

function usage(): string {
  return [
    `usage: ${ATLAS_PRODUCT} <serve|migrate|version|project|contributor|metrics>`,
    '',
    '  serve                     run the HTTP service (ATLAS_BIND_HOST, ATLAS_PORT)',
    '  migrate                   apply pending migrations and exit',
    '  version                   print the product and version',
    '  project list              list registered projects',
    '  project add <id> <name>   add a project; repo identities come from',
    '                            --repos=host/path,host/path',
    '  contributor list          list contributor bindings (never tokens)',
    '  contributor add <host>    bind a new contributor token to a host and',
    '                            --projects=a,b; prints the token ONCE',
    '  contributor remove <host> revoke every token bound to a host',
    '  metrics                   render /metrics once, for cron or debugging',
    '',
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return undefined;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'version' || cmd === '--version' || cmd === '-V') {
    process.stdout.write(`${ATLAS_PRODUCT} ${ATLAS_VERSION}\n`);
    return;
  }
  if (!cmd || cmd === '--help' || cmd === '-h') {
    // Help is not an error: stdout, exit 0, so `atlas --help > usage.txt` captures something.
    process.stdout.write(usage());
    return;
  }

  const config = loadAtlasConfig();
  const redactor = createRedactor(config.secrets);
  const log = createLogger(redactor, config.logLevel);
  const db = openDatabase(config.dbPath);

  try {
    // Contributor tokens are seeded on EVERY start, not only on migrate, so rotating a token is an
    // edit to a 0600 file plus a restart rather than a database change. The plaintext values are added
    // to the redactor for the same reason the host seeds its redactor with forwarded credentials: a
    // pattern pass cannot recognise a bare token it has no label for.
    const seeded = seedContributors(db, config.contributorsFile);
    const auth = new AuthIndex(db, config);
    const metrics = new AtlasMetrics();
    const store = new NoteStore(db, {
      maxClaimBytes: config.maxClaimBytes,
      maxDetailBytes: config.maxDetailBytes,
      maxEvidence: 8,
    }, redactor);
    const services = { db, config, store, auth, log, metrics };

    switch (cmd) {
      case 'migrate': {
        log.info('migrations applied', { db: config.dbPath });
        return;
      }
      case 'metrics': {
        process.stdout.write(metrics.render(store));
        return;
      }
      case 'project': {
        const sub = args[0];
        if (sub === 'list') {
          process.stdout.write(JSON.stringify(store.listProjects(), null, 2) + '\n');
          return;
        }
        if (sub === 'add') {
          const id = args[1];
          const name = args[2];
          if (!id || !name) throw new Error('project add needs <id> <name>');
          const repos = csv(flag(args, 'repos'));
          if (repos.length === 0) {
            // A project with no repo identities accepts nothing (section 5's cross-check has nothing
            // to match), so saying so here beats an operator discovering it from a silent outbox.
            throw new Error('project add needs --repos=host/path[,host/path]; a project with no identities accepts no notes');
          }
          if (store.getProject(id)) throw new Error(`project ${id} already exists`);
          process.stdout.write(JSON.stringify(store.createProject({ id, name, repoIdentities: repos }), null, 2) + '\n');
          return;
        }
        fail(`project: unknown subcommand '${sub ?? ''}'`);
        return;
      }
      case 'contributor': {
        const sub = args[0];
        if (sub === 'list') {
          process.stdout.write(JSON.stringify(store.listContributors(), null, 2) + '\n');
          return;
        }
        if (sub === 'add') {
          const hostId = args[1];
          const projects = csv(flag(args, 'projects'));
          if (!hostId) throw new Error('contributor add needs <hostId>');
          if (projects.length === 0) throw new Error('contributor add needs --projects=a,b');
          const token = randomToken();
          store.addContributor(hashToken(token), hostId, projects);
          // Printed once, to stdout, because it is unrecoverable afterwards -- the database holds only
          // its hash. Everything that reads this output should pipe it straight into a secret store.
          process.stdout.write(`${token}\n`);
          log.info('contributor added', { hostId, projects });
          return;
        }
        if (sub === 'remove') {
          const hostId = args[1];
          if (!hostId) throw new Error('contributor remove needs <hostId>');
          const removed = store.removeContributorByHost(hostId);
          process.stdout.write(`${removed} contributor token(s) revoked for ${hostId}\n`);
          return;
        }
        fail(`contributor: unknown subcommand '${sub ?? ''}'`);
        return;
      }
      case 'serve': {
        const server = await startAtlas(services);
        log.info(`${ATLAS_PRODUCT} listening`, { url: server.url, db: config.dbPath, tls: Boolean(config.tlsCert) });
        // The seeded and configured tokens are secrets this process holds and must never print, but
        // their EXISTENCE is worth logging so an operator can see the registry is not empty.
        if (seeded.length > 0) log.info('contributors seeded from file', { count: seeded.length });
        await new Promise<void>((resolve) => {
          const shutdown = (): void => {
            void server.close().then(() => {
              db.close();
              resolve();
            });
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
        return;
      }
      default:
        fail(`unknown command '${cmd}'`);
    }
  } catch (err) {
    // The message goes to stderr because every one of these is actionable configuration feedback.
    // Redaction still applies: a bad token value can end up interpolated into a message.
    log.error('atlas command failed', { err: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

/**
 * A contributor token: 32 random bytes, printed once and stored only as a hash.
 *
 * base64url rather than hex so the token is short enough to fit comfortably in an environment file,
 * and URL-safe so it survives being pasted through a web UI without escaping.
 */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function fail(message: string): never {
  process.stderr.write(`${message}\n${usage()}`);
  process.exit(1);
}

void main();
