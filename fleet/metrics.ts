import type { HostRegistry } from './registry.ts';
import type { ChildClient } from './child.ts';

/**
 * Metrics rollup (docs/fleet-design.md section 12, Phase 6): scrape every child's `/metrics`, merge, serve one
 * Prometheus endpoint.
 *
 * Two decisions worth stating, because both were tempting to get wrong:
 *
 * **Series are relabelled, not summed.** Summing across hosts would destroy the per-host view, which is the
 * entire reason to run a fleet, and would be actively wrong for some series -- summing a gauge of lease
 * timestamps or a per-status count across heterogeneous hosts produces a number that means nothing. Instead
 * every series gains `host="<hostId>"` and Prometheus aggregates with `sum by (...)` at query time, which is
 * what it is good at and what keeps the choice reversible.
 *
 * **A scrape failure is data, not an exception.** One unreachable child must not blank the fleet dashboard, so
 * the rollup always renders whatever came back and publishes `mercury_fleet_scrape_success` per host. Without
 * that gauge a host vanishing from the output is indistinguishable from a host with nothing to report.
 */

/** The label Fleet adds to every scraped series. */
export const HOST_LABEL = 'host';

export interface ParsedFamily {
  name: string;
  help: string | null;
  type: string | null;
  /** Sample lines verbatim, minus the leading metric name and labels which are re-rendered. */
  samples: Array<{ name: string; labels: Array<[string, string]>; value: string }>;
}

/**
 * Parse the Prometheus text exposition format into families.
 *
 * Deliberately strict about what it does not understand: an unrecognised line is reported rather than skipped,
 * because silently dropping a metric family is how a rollup ends up quietly under-reporting.
 */
export function parseExposition(text: string): { families: ParsedFamily[]; unparsed: string[] } {
  const families: ParsedFamily[] = [];
  const unparsed: string[] = [];
  const byName = new Map<string, ParsedFamily>();
  let pendingHelp: string | null = null;
  let pendingType: string | null = null;

  const family = (name: string): ParsedFamily => {
    let f = byName.get(name);
    if (!f) {
      f = { name, help: null, type: null, samples: [] };
      byName.set(name, f);
      families.push(f);
    }
    return f;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const m = /^#\s*(HELP|TYPE)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) {
        // A comment we do not recognise (a `# UNIT`, a human note). Not a violation, but not silently eaten.
        unparsed.push(line);
        continue;
      }
      const [, kind, name, rest] = m as unknown as [string, 'HELP' | 'TYPE', string, string];
      if (kind === 'HELP') {
        pendingHelp = rest;
        family(name).help = rest;
      } else {
        pendingType = rest;
        family(name).type = rest;
      }
      continue;
    }
    // Sample line: name{labels} value [timestamp]
    const m = /^(\w+)(?:\{([^}]*)\})?\s+(-?[0-9eE+._infNaNinf]+)(?:\s+\S+)?\s*$/.exec(line);
    if (!m) {
      unparsed.push(line);
      continue;
    }
    const [, name, labelText] = m as unknown as [string, string, string | undefined];
    // A histogram bucket carries `le`, a summary carries `quantile`; the family is the name without the suffix.
    const base = name.replace(/_(bucket|sum|count)$/, '');
    const f = family(base);
    if (f.help === null && pendingHelp !== null) f.help = pendingHelp;
    if (f.type === null && pendingType !== null) f.type = pendingType;
    f.samples.push({ name, labels: parseLabels(labelText ?? ''), value: m[3]! });
  }
  return { families, unparsed };
}

/**
 * Split a label list. Handles escaped quotes inside values, because a label value containing a quote is exactly
 * what a hostile or merely unlucky metric can produce.
 */
export function parseLabels(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ',' || text[i] === ' ')) i++;
    const eq = text.indexOf('=', i);
    if (eq === -1) break;
    const key = text.slice(i, eq).trim();
    if (text[eq + 1] !== '"') break;
    let j = eq + 2;
    let value = '';
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; continue; }
      if (ch === '"') { j++; break; }
      value += ch;
      j++;
    }
    if (key) out.push([key, value]);
    i = j;
  }
  return out;
}

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: Array<[string, string]>): string {
  if (labels.length === 0) return '';
  const sorted = [...labels].sort(([a], [b]) => (a < b ? -1 : 1));
  return '{' + sorted.map(([k, v]) => `${k}="${escapeValue(v)}"`).join(',') + '}';
}

export interface ScrapeResult {
  hostId: string;
  /** Null when the scrape failed; reason explains which kind of failure. */
  text: string | null;
  reason: string | null;
}

/**
 * Merge scrapes into one exposition.
 *
 * Pure, and returns the unparsed lines rather than logging them, so a test can assert on exactly what was
 * dropped and why. A rollup that quietly loses a family is worse than one that fails loudly.
 */
export function mergeRollup(results: ScrapeResult[]): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  // Family order follows first-seen order across hosts, and HELP/TYPE are emitted once no matter how many
  // children declared them -- duplicate TYPE lines make the whole scrape invalid to Prometheus.
  const order: string[] = [];
  const merged = new Map<string, { help: string | null; type: string | null; lines: string[] }>();

  const slot = (name: string) => {
    let s = merged.get(name);
    if (!s) {
      s = { help: null, type: null, lines: [] };
      merged.set(name, s);
      order.push(name);
    }
    return s;
  };

  for (const scrape of results) {
    const success = slot('mercury_fleet_scrape_success');
    success.help ??= 'Whether Fleet could scrape this host (1) or not (0).';
    success.type ??= 'gauge';
    success.lines.push(`${HOST_LABEL}_placeholder`); // replaced below; keeps ordering simple

    if (scrape.text === null) {
      dropped.push(`${scrape.hostId}: ${scrape.reason ?? 'scrape failed'}`);
      continue;
    }
    const { families, unparsed } = parseExposition(scrape.text);
    for (const line of unparsed) dropped.push(`${scrape.hostId}: unparsed line ${JSON.stringify(line)}`);
    for (const f of families) {
      const s = slot(f.name);
      if (s.help === null && f.help !== null) s.help = f.help;
      if (s.type === null && f.type !== null) s.type = f.type;
      else if (s.type !== null && f.type !== null && s.type !== f.type) {
        // Two children disagreeing about a type cannot both be honoured: the first wins and the disagreement is
        // reported, because a silent mismatch makes one host's series unreadable in a way nobody notices.
        dropped.push(`${scrape.hostId}: TYPE mismatch for ${f.name} (${s.type} kept, ${f.type} ignored)`);
      }
      for (const sample of f.samples) {
        if (sample.labels.some(([k]) => k === HOST_LABEL)) {
          // Defensive: Mercury never labels a series `host` today. If a child ever does, emitting two labels
          // with the same name produces text Prometheus rejects outright, so dropping one with a report beats
          // poisoning the whole endpoint.
          dropped.push(`${scrape.hostId}: series ${sample.name} already carries a ${HOST_LABEL} label; skipped`);
          continue;
        }
        s.lines.push(`${sample.name}${renderLabels([...sample.labels, [HOST_LABEL, scrape.hostId]])} ${sample.value}`);
      }
    }
  }

  const out: string[] = [];
  for (const name of order) {
    const s = merged.get(name)!;
    if (s.help !== null) out.push(`# HELP ${name} ${s.help}`);
    if (s.type !== null) out.push(`# TYPE ${name} ${s.type}`);
    if (name === 'mercury_fleet_scrape_success') {
      for (const scrape of results) {
        out.push(`mercury_fleet_scrape_success${renderLabels([[HOST_LABEL, scrape.hostId]])} ${scrape.text === null ? 0 : 1}`);
      }
      continue;
    }
    out.push(...s.lines.filter((l) => l !== `${HOST_LABEL}_placeholder`));
  }
  return { text: out.join('\n') + '\n', dropped };
}

export interface MetricsDeps {
  registry: HostRegistry;
  child: ChildClient;
  resolveToken: (credentialRef: string) => string | null;
  timeoutMs: number;
}

/** Scrape every named host in parallel. Each scrape is independently bounded by the child client's timeout. */
export async function scrapeAll(deps: MetricsDeps, hostIds: string[]): Promise<ScrapeResult[]> {
  return Promise.all(hostIds.map(async (hostId): Promise<ScrapeResult> => {
    const host = deps.registry.get(hostId);
    if (!host) return { hostId, text: null, reason: 'not in the registry' };
    const token = deps.resolveToken(host.credentialRef);
    if (!token) return { hostId, text: null, reason: 'credential unavailable' };
    const res = await deps.child.getMetrics({ baseUrl: host.baseUrl, token });
    if (res.kind !== 'ok') {
      return { hostId, text: null, reason: res.kind === 'rejected' ? `child answered ${res.status}` : res.reason };
    }
    return { hostId, text: res.value, reason: null };
  }));
}
