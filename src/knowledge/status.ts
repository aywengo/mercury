/**
 * `GET /api/knowledge/status` (docs/knowledge-base.md section 8.5), and the same answer for
 * `node src/cli.ts knowledge status`.
 *
 * Computed in one place so the CLI and the API cannot disagree. Both are read-only projections of
 * tables the worker writes, and the questions they answer are the same two questions: is this host
 * still sending, and is it still receiving.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeConfig } from '../config.ts';
import { OutboxStore, SYNC_KEYS } from './outbox.ts';

export interface KnowledgeStatus {
  /** False when `MERCURY_ATLAS_URL` is unset. Everything below is then empty rather than absent,
   *  so a client never has to distinguish "off" from "no data". */
  enabled: boolean;
  project: string | null;
  hostId: string | null;
  outbox: {
    depth: number;
    /** The oldest unsent row. Depth alone cannot tell a draining backlog from a stuck one. */
    oldest: { id: number; createdAt: string; attempts: number; lastError: string | null } | null;
  };
  lastPush: { at: string | null; error: string | null; failures: number };
  lastPull: { at: string | null; error: string | null };
  /**
   * The replica cursor and note count. Both are null until the replica exists (phase 2), and null
   * here means "this host has never pulled", which is a real answer rather than a missing field.
   */
  replica: { cursor: number | null; notes: number | null };
}

/**
 * Build the status payload.
 *
 * Reads the replica tables only when they exist. The phases land separately, and a status route that
 * throws because a later migration has not arrived yet would take down an endpoint an operator needs
 * precisely while a rollout is half-finished.
 */
export function knowledgeStatus(db: DatabaseSync, config: KnowledgeConfig): KnowledgeStatus {
  const outbox = new OutboxStore(db);
  const failures = Number(outbox.getState('push_failures_total') ?? '0');
  return {
    enabled: config.atlas !== null,
    project: config.atlas?.project ?? null,
    hostId: config.atlas?.hostId ?? null,
    outbox: { depth: outbox.depth(), oldest: outbox.oldest() },
    lastPush: {
      at: outbox.getState(SYNC_KEYS.lastPushAt),
      error: outbox.getState(SYNC_KEYS.lastPushError) || null,
      failures: Number.isFinite(failures) ? failures : 0,
    },
    lastPull: {
      at: outbox.getState(SYNC_KEYS.lastPullAt),
      error: outbox.getState(SYNC_KEYS.lastPullError) || null,
    },
    replica: replicaStatus(db),
  };
}

function replicaStatus(db: DatabaseSync): { cursor: number | null; notes: number | null } {
  if (!tableExists(db, 'knowledge_replica_cursor')) return { cursor: null, notes: null };
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM knowledge_replica_cursor').get() as { seq: number };
  const notes = tableExists(db, 'knowledge_replica')
    ? (db.prepare('SELECT COUNT(*) AS n FROM knowledge_replica').get() as { n: number }).n
    : null;
  return { cursor: Number(row.seq) || 0, notes };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
