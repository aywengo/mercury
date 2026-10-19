/**
 * Fields the SERVER stamps on a Run. No request body may carry one (A0-3, issue #988).
 *
 * Both Run-creating routes forward NAMED fields, so an unrecognised key was already ignored -- but
 * ignored is not the same as refused, and a caller who sends `origin` or `ownerId` believes they set
 * it. Silently dropping a server-stamped attribution field is the exact failure #988 exists to
 * prevent, so the routes refuse such a body outright with a 400 instead.
 *
 * The list is the server's own write set for a new Run:
 *   - `origin`    provenance, written from an internal-only create parameter (#988);
 *   - `ownerId`   taken from the authenticated token, never the body (AGENTS.md owner-scoping);
 *   - `retryOf`, `attempt`  the retry link, written by the child's INSERT (#987);
 *   - `status`    the state machine's, and always QUEUED at creation.
 *
 * A field the CALLER legitimately supplies (`task`, `constraints`, `agent`, `model`, ...) must never
 * be added here: this list is a refusal, and a refusal on a valid field breaks working callers.
 */
export const SERVER_STAMPED_FIELDS = ['origin', 'ownerId', 'retryOf', 'attempt', 'status'] as const;

export type ServerStampedField = (typeof SERVER_STAMPED_FIELDS)[number];

/**
 * The first server-stamped field present in a request body, or null.
 *
 * Presence is `!== undefined`, so an explicit `"origin": null` is still an attempt to set it and is
 * still refused. A non-object body (null, an array, a bare string) has no fields to check and is
 * left for the route's own validation to reject.
 */
export function findServerStampedField(body: unknown): ServerStampedField | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return SERVER_STAMPED_FIELDS.find((field) => record[field] !== undefined) ?? null;
}

/** The 400 message for a body that carries a server-stamped field. */
export function serverStampedFieldMessage(field: ServerStampedField): string {
  return `${field} is set by the server and cannot be supplied in a request body`;
}
