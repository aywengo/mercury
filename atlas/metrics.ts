/**
 * `/metrics` (docs/knowledge-base.md section 11.1).
 *
 * Two kinds of number, and the difference matters enough to say it:
 *
 *   FROM THE DATABASE -- notes per project by tier and kind, and per-contributor freshness. These are
 *     the state, and the database is the only record of it.
 *   IN PROCESS -- contributions and rejections by reason. These are rates, and a Prometheus counter
 *     that resets on restart is the normal shape of a rate; `rate()` in PromQL is built for exactly
 *     that. Persisting them would mean a table of operational telemetry inside a store whose whole
 *     purpose is curated claims, which is what K1 argues against.
 *
 * Cardinality is bounded by construction: every label comes from a closed set (project ids are the
 * registry's, tiers and kinds are the enumerations in `types.ts`, rejection reasons are the closed
 * `REJECT_REASONS` list). Nothing is labelled by note id, run id or claim text.
 */

import type { NoteStore } from './notes.ts';
import { NOTE_KINDS, NOTE_TIERS } from './types.ts';
import { REJECT_REASONS } from './validation.ts';

export class AtlasMetrics {
  private contributions = 0;
  private rejections = new Map<string, number>();
  private duplicates = 0;
  private accepted = 0;

  /** Record one batch's per-item outcomes. Called by the contribute route, once per batch. */
  recordContribution(results: { accepted?: string; duplicate?: string; rejected?: string }[]): void {
    for (const r of results) {
      this.contributions += 1;
      // Checked by value rather than with `in`. The store's result type marks each verdict optional
      // so a caller can test which key it got, and `in` does not narrow an optional property -- the
      // compiler would otherwise be right that `rejected` might be undefined here.
      if (typeof r.accepted === 'string') this.accepted += 1;
      else if (typeof r.duplicate === 'string') this.duplicates += 1;
      else if (typeof r.rejected === 'string') this.rejections.set(r.rejected, (this.rejections.get(r.rejected) ?? 0) + 1);
    }
  }

  render(store: NoteStore): string {
    const out: string[] = [];
    const line = (name: string, labels: Record<string, string>, value: number): void => {
      const sel = Object.keys(labels).map((k) => `${k}="${escapeLabel(labels[k] as string)}"`).join(',');
      out.push(`${name}${sel ? `{${sel}}` : ''} ${value}`);
    };

    out.push('# HELP atlas_notes Notes currently held, by project, tier and kind.');
    out.push('# TYPE atlas_notes gauge');
    // Seeded across the full cross product so a project with no pitfalls reports zero rather than
    // nothing. A missing series and a zero mean different things on a dashboard, and the second is
    // the truth here.
    const seen = new Set<string>();
    for (const row of store.countsByProject()) {
      line('atlas_notes', { project: row.projectId, tier: row.tier, kind: row.kind }, row.n);
      seen.add(`${row.projectId}\u0000${row.tier}\u0000${row.kind}`);
    }
    for (const project of store.listProjects()) {
      for (const tier of NOTE_TIERS) {
        for (const kind of NOTE_KINDS) {
          if (!seen.has(`${project.id}\u0000${tier}\u0000${kind}`)) {
            line('atlas_notes', { project: project.id, tier, kind }, 0);
          }
        }
      }
    }

    out.push('# HELP atlas_contributions_total Notes received from hosts, by outcome.');
    out.push('# TYPE atlas_contributions_total counter');
    line('atlas_contributions_total', { outcome: 'accepted' }, this.accepted);
    line('atlas_contributions_total', { outcome: 'duplicate' }, this.duplicates);
    line('atlas_contributions_total', { outcome: 'rejected' }, this.rejectionsTotal());

    out.push('# HELP atlas_rejections_total Notes refused, by reason. A closed label set: every value');
    out.push('# is one the host can act on. An open reason string is a reason nobody aggregates.');
    out.push('# TYPE atlas_rejections_total counter');
    for (const reason of REJECT_REASONS) line('atlas_rejections_total', { reason }, this.rejections.get(reason) ?? 0);

    out.push('# HELP atlas_contributor_last_seen_seconds Unix time of the last authenticated request');
    out.push('# from this contributor, or 0 if it has never connected. Joined by eye with Fleet\'s host');
    out.push('# registry when operators use the same ids, this shows which hosts are learning and which');
    out.push('# have gone quiet.');
    out.push('# TYPE atlas_contributor_last_seen_seconds gauge');
    for (const c of store.lastContributionByHost()) {
      line('atlas_contributor_last_seen_seconds', { host: c.hostId }, c.lastSeenAt ? Math.floor(Date.parse(c.lastSeenAt) / 1000) : 0);
    }

    out.push('# HELP atlas_projects Projects registered with this Atlas instance.');
    out.push('# TYPE atlas_projects gauge');
    line('atlas_projects', {}, store.listProjects().length);

    return out.join('\n') + '\n';
  }

  private rejectionsTotal(): number {
    let n = 0;
    for (const v of this.rejections.values()) n += v;
    return n;
  }

  /** Totals for `atlas status`, so the CLI and /metrics cannot disagree about the same counter. */
  totals(): { contributions: number; accepted: number; duplicates: number; rejected: number } {
    return { contributions: this.contributions, accepted: this.accepted, duplicates: this.duplicates, rejected: this.rejectionsTotal() };
  }
}

/** Prometheus label escaping: a quote or a newline in a label value can otherwise forge a sample. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
