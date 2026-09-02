#!/usr/bin/env node
/**
 * Fleet CLI. Phase 0: registry and probe only, no dispatch (docs/fleet-design.md section 12).
 *
 * Usage:
 *   fleet hosts add <id> --url <base> --credential <ref> [--label k=v] [--path <abs>] [--disabled]
 *   fleet hosts list [--json] [--live]
 *   fleet hosts enable|disable <id>
 *   fleet hosts rm <id>
 *   fleet hosts probe [<id>] [--json]
 *   fleet probe --watch            run the sweep on FLEET_PROBE_INTERVAL_MS until interrupted
 *   fleet credentials list         credential NAMES only; values are never printed
 *
 * No command accepts a child credential as an argument. argv is world-readable through ps, so the secret
 * lives in the credential file and only its name travels (design section 9).
 */

import { loadConfig } from './config.ts';
import { openFleetDb } from './db.ts';
import { HostRegistry, RegistryError, type HostView, type ProbeRecord } from './registry.ts';
import { loadCredentials, CredentialError, type CredentialStore } from './credentials.ts';
import { createProber } from './prober.ts';
import { probeAndRecord } from './probe.ts';

const USAGE = `fleet -- manage multiple Mercury instances

  fleet hosts add <id> --url <base> --credential <ref> [--label k=v] [--path <abs>] [--disabled]
  fleet hosts list [--json] [--live]
  fleet hosts enable|disable <id>
  fleet hosts rm <id>
  fleet hosts probe [<id>] [--json]
  fleet probe --watch
  fleet credentials list
`;

/** Human label per outcome. Kept distinct because each one sends the operator somewhere different. */
const STATE_LABEL: Record<ProbeRecord['outcome'], string> = {
  ok: 'up',
  unreachable: 'down',
  unauthorized: 'auth-fail',
  not_mercury: 'not-mercury',
  not_serving: 'no-worker',
  http_error: 'http-error',
  timeout: 'timeout',
};

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
  multi: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multi = new Map<string, string[]>();
  const repeatable = new Set(['label', 'path']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith('--');
    if (!takesValue) {
      flags.set(key, true);
      continue;
    }
    i++;
    if (repeatable.has(key)) {
      const list = multi.get(key) ?? [];
      list.push(next!);
      multi.set(key, list);
    } else {
      flags.set(key, next!);
    }
  }
  return { positionals, flags, multi };
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function stateOf(view: HostView): string {
  if (!view.enabled) return 'disabled';
  if (!view.probe) return 'never-probed';
  return STATE_LABEL[view.probe.outcome] ?? view.probe.outcome;
}

function renderTable(rows: HostView[]): string {
  const header = ['ID', 'STATE', 'SEEN', 'WORKERS', 'RUNS', 'QUEUE', 'AGENTS', 'URL'];
  const body = rows.map((r) => {
    const p = r.probe;
    return [
      r.id,
      stateOf(r),
      ago(p?.probedAt ?? r.lastSeenAt),
      p?.workerCount === null || p?.workerCount === undefined ? '-' : String(p.workerCount),
      p?.activeRuns === null || p?.activeRuns === undefined ? '-' : String(p.activeRuns),
      p?.queueDepth === null || p?.queueDepth === undefined ? '-' : String(p.queueDepth),
      p?.agents?.length ? String(p.agents.length) : r.agentsCache.length ? String(r.agentsCache.length) : '-',
      r.baseUrl,
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(header)];
  // Detail lines carry the diagnosis, which is the part a fixed-width table cannot hold.
  for (let i = 0; i < rows.length; i++) {
    out.push(line(body[i]!));
    const p = rows[i]!.probe;
    if (p?.detail && p.outcome !== 'ok') out.push(`    ${rows[i]!.id}: ${p.detail}`);
  }
  return out.join('\n');
}

function parseLabels(pairs: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new RegistryError(`--label expects key=value, got ${JSON.stringify(pair)}`);
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

function openStore(config: ReturnType<typeof loadConfig>): CredentialStore {
  return loadCredentials(config.credentialsFile, config.allowInsecureCredentials);
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const config = loadConfig();
  const { positionals, flags, multi } = parseArgs(argv);
  const [group, action] = positionals;
  const asJson = flags.get('json') === true;

  const withRegistry = async (fn: (registry: HostRegistry, db: ReturnType<typeof openFleetDb>['db']) => Promise<number> | number) => {
    const { db } = openFleetDb(config.dbPath);
    try {
      return await fn(new HostRegistry(db), db);
    } finally {
      db.close();
    }
  };

  if (group === 'credentials') {
    if (action !== 'list') {
      process.stderr.write('usage: fleet credentials list\n');
      return 2;
    }
    // Names only. Printing values here would put every child credential in terminal scrollback and any
    // captured log, which is the exposure the file's 0600 mode exists to prevent.
    const store = openStore(config);
    const names = store.names();
    process.stdout.write(
      asJson ? JSON.stringify({ credentialsFile: config.credentialsFile, refs: names }, null, 2) + '\n'
        : names.length ? names.join('\n') + '\n' : `(no credentials in ${config.credentialsFile})\n`,
    );
    return 0;
  }

  if (group === 'probe') {
    return withRegistry(async (registry) => {
      const store = openStore(config);
      const prober = createProber({
        registry,
        resolveToken: (ref) => store.secret(ref),
        intervalMs: config.probeIntervalMs,
        timeoutMs: config.probeTimeoutMs,
      });
      if (flags.get('once') === true || flags.get('watch') !== true) {
        const results = await prober.sweepOnce();
        process.stdout.write(`probed ${results.length} enabled host(s)\n`);
        process.stdout.write(renderTable(registry.listWithProbe()) + '\n');
        return 0;
      }
      // --watch: sweep immediately so the operator sees state, then keep sweeping on the timer.
      await prober.sweepOnce();
      prober.start();
      process.stdout.write(
        `sweeping every ${Math.round(config.probeIntervalMs / 1000)}s; Ctrl-C to stop\n`,
      );
      await new Promise<void>((resolve) => {
        const done = () => {
          prober.stop();
          resolve();
        };
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      return 0;
    });
  }

  if (group !== 'hosts') {
    process.stderr.write(`unknown command group ${JSON.stringify(group ?? '')}\n\n${USAGE}`);
    return 2;
  }

  return withRegistry((registry) => {
    if (action === 'add') {
      const id = positionals[2];
      const url = flags.get('url');
      const cred = flags.get('credential');
      if (!id || typeof url !== 'string' || typeof cred !== 'string') {
        process.stderr.write(
          'usage: fleet hosts add <id> --url <base> --credential <ref> [--label k=v] [--path <abs>]\n' +
            '  --credential names a ref in the credential file; the secret itself is never an argument.\n',
        );
        return 2;
      }
      // Validate the ref resolves NOW. Accepting a typo here would defer the failure to a probe that
      // reports the host as auth-fail, pointing at the host when the mistake is in this command.
      const store = openStore(config);
      store.secret(cred);
      registry.add({
        id,
        baseUrl: url,
        credentialRef: cred,
        labels: parseLabels(multi.get('label') ?? []),
        localPaths: multi.get('path') ?? [],
        enabled: flags.get('disabled') !== true,
      });
      process.stdout.write(`added ${id}\n`);
      return 0;
    }

    if (action === 'list') {
      return (async () => {
        if (flags.get('live') === true) {
          const store = openStore(config);
          const prober = createProber({
            registry,
            resolveToken: (ref) => store.secret(ref),
            intervalMs: config.probeIntervalMs,
            timeoutMs: config.probeTimeoutMs,
          });
          await prober.sweepOnce();
        }
        const rows = registry.listWithProbe();
        if (asJson) {
          process.stdout.write(JSON.stringify({ hosts: rows }, null, 2) + '\n');
          return 0;
        }
        process.stdout.write((rows.length ? renderTable(rows) : '(no hosts; add one with `fleet hosts add`)') + '\n');
        return 0;
      })();
    }

    if (action === 'enable' || action === 'disable') {
      const id = positionals[2];
      if (!id) {
        process.stderr.write(`usage: fleet hosts ${action} <id>\n`);
        return 2;
      }
      registry.setEnabled(id, action === 'enable');
      process.stdout.write(`${id} ${action}d\n`);
      return 0;
    }

    if (action === 'rm' || action === 'remove') {
      const id = positionals[2];
      if (!id) {
        process.stderr.write('usage: fleet hosts rm <id>\n');
        return 2;
      }
      const removed = registry.remove(id);
      process.stdout.write(removed ? `removed ${id}\n` : `no such host: ${id}\n`);
      return removed ? 0 : 1;
    }

    if (action === 'probe') {
      return (async () => {
        const store = openStore(config);
        const only = positionals[2];
        const prober = createProber({
          registry,
          resolveToken: (ref) => store.secret(ref),
          intervalMs: config.probeIntervalMs,
          timeoutMs: config.probeTimeoutMs,
        });
        if (!only) {
          await prober.sweepOnce();
          const rows = registry.listWithProbe();
          process.stdout.write(asJson ? JSON.stringify({ hosts: rows }, null, 2) + '\n' : renderTable(rows) + '\n');
          return 0;
        }
        const host = registry.get(only);
        if (!host) {
          process.stderr.write(`no such host: ${only}\n`);
          return 1;
        }
        const rec = await probeAndRecord({
          hostId: host.id, baseUrl: host.baseUrl, token: store.secret(host.credentialRef),
          timeoutMs: config.probeTimeoutMs,
        });
        registry.recordProbe(rec);
        process.stdout.write(asJson ? JSON.stringify(rec, null, 2) + '\n' : renderTable(registry.listWithProbe()) + '\n');
        // Exit non-zero when the host is not usable, so this composes in a readiness check.
        return rec.outcome === 'ok' ? 0 : 1;
      })();
    }

    process.stderr.write(`unknown hosts subcommand ${JSON.stringify(action ?? '')}\n\n${USAGE}`);
    return 2;
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const e = err as Error;
    if (e instanceof RegistryError || e instanceof CredentialError) {
      process.stderr.write(`fleet: ${e.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`fleet: unexpected error: ${e.stack ?? e.message}\n`);
    process.exitCode = 1;
  });
