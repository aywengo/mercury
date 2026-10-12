/**
 * Validation of the `persona` block on `POST /api/runs` (docs/crew/agent-templates.md §4
 * Phase 0, issue #911).
 *
 * Fail-closed, for the same reason every other admission block here is: a persona that is
 * accepted and then quietly ignored leaves the caller believing the agent will present the
 * identity they asked for. An omitted block means "no persona" and never fails.
 *
 * Two structured channels only, per the template rule that a Run must not carry arbitrary argv:
 * `append` is text the adapter renders through its own system-prompt surface, `files` are
 * workspace-relative files materialized from these exact bytes. There is no flag, no command
 * and no path outside the workspace in either channel.
 */

export class PersonaRequestError extends Error {}

/** Hard cap on the total persona payload (bytes, UTF-8), matching the instruction cap's spirit. */
export const PERSONA_MAX_BYTES = 256 * 1024;

export interface PersonaRequest {
  append?: string;
  files?: { path: string; content: string }[];
}

/** A workspace-relative path that stays inside the workspace and names a regular file. */
const PERSONA_FILE_PATH = /^[^\0]+$/;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function parsePersonaRequest(raw: unknown): PersonaRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PersonaRequestError('persona must be an object');
  }
  const body = raw as Record<string, unknown>;
  const out: PersonaRequest = {};
  let total = 0;

  if (body.append !== undefined) {
    if (typeof body.append !== 'string' || body.append.trim().length === 0) {
      throw new PersonaRequestError('persona.append must be a non-empty string');
    }
    out.append = body.append;
    total += byteLength(body.append);
  }

  if (body.files !== undefined) {
    if (!Array.isArray(body.files)) {
      throw new PersonaRequestError('persona.files must be an array of { path, content } objects');
    }
    const files: { path: string; content: string }[] = [];
    const seen = new Set<string>();
    for (const f of body.files) {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        throw new PersonaRequestError('persona.files entries must be { path, content } objects');
      }
      const { path, content } = f as Record<string, unknown>;
      if (typeof path !== 'string' || path.length === 0) {
        throw new PersonaRequestError('persona.files[].path must be a non-empty string');
      }
      // Same shape the skill snapshot keys use: workspace-relative POSIX, no traversal, no
      // absolute path. The worker's resolveContained re-checks containment at write time, but
      // refusing here gives the caller a 400 instead of a half-created workspace.
      if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
        throw new PersonaRequestError(
          `persona.files[].path must be a workspace-relative POSIX path without traversal: ${JSON.stringify(path)}`,
        );
      }
      if (!PERSONA_FILE_PATH.test(path)) {
        throw new PersonaRequestError(`persona.files[].path contains a NUL byte: ${JSON.stringify(path)}`);
      }
      if (seen.has(path)) {
        throw new PersonaRequestError(`persona.files names ${JSON.stringify(path)} twice`);
      }
      seen.add(path);
      if (typeof content !== 'string') {
        throw new PersonaRequestError(`persona.files[${JSON.stringify(path)}].content must be a string`);
      }
      files.push({ path, content });
      total += byteLength(path) + byteLength(content);
    }
    out.files = files;
  }

  if (out.append === undefined && out.files === undefined) {
    throw new PersonaRequestError('persona must carry append or files');
  }
  if (total > PERSONA_MAX_BYTES) {
    throw new PersonaRequestError(
      `persona payload exceeds the ${PERSONA_MAX_BYTES}-byte cap (got ${total} bytes)`,
    );
  }
  return out;
}

/** Why a Run that asked for a persona cannot get one, phrased so the caller can act on it. */
export function personaCapabilityMessage(agent: string, field: 'append' | 'files', reason: string): string {
  const what = field === 'append' ? 'persona.append' : 'persona.files';
  return (
    `the ${what} persona was requested, but agent ${JSON.stringify(agent)} cannot receive one`
    + ` (${reason}); pick an agent that declares the persona channel, or drop ${what}`
  );
}
