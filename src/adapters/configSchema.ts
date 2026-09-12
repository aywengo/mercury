/**
 * Declarative-config key checking (issue #500).
 *
 * The three declarative adapters (local, rpc, remote) are configured by operator-authored JSON.
 * Their validators checked required fields and value shapes but never looked at keys they did not
 * recognise, so a misspelling was indistinguishable from an omission. For most fields that is
 * merely confusing. For `goalSupport` it is the worst available outcome: `"goalSuport"` reads as
 * "no goals", which is a legitimate value, so the operator believes goals are enabled while every
 * attempt is refused with a message that is technically true.
 *
 * The nested case is worse than the top-level one. `"goalSupport": { "sett": "1.0.0" }` is a
 * truthy object, so the capability getter returns `{ goals }` and Mercury **advertises** goal
 * support backed by a version claim that does not exist. That fails later, further from the cause,
 * and in the opposite direction from the fail-closed default. So the check is recursive.
 *
 * Forward compatibility was decided as: reject outright, with no `_allowUnknownKeys` escape hatch.
 * A hatch re-introduces exactly the silence being removed and is sticky -- set once to unblock a
 * boot, never removed again. If forward compatibility becomes a real requirement, the answer is an
 * explicit `configVersion` with defined handling, not a blanket "ignore what you do not understand".
 * See docs/agent-adapters.md.
 *
 * Some objects are deliberately OPEN: `eventMap` maps arbitrary agent event type names to Mercury
 * event types, and `env` / `body` / `statusMap` carry operator-chosen keys by design. Strictness
 * there would reject the feature, so openness is declared per node rather than assumed globally.
 */

import { levenshtein } from './configKeys.ts';

/** A scalar or array: nothing inside to check. */
export interface LeafSchema { readonly kind: 'leaf' }
/** Arbitrary keys; every value is checked against `values`. */
export interface MapSchema { readonly kind: 'map'; readonly values: ConfigSchema }
/**
 * A closed object: only the listed keys are accepted.
 *
 * Generic in its key set so a schema constant keeps its precise keys after inference, which is
 * what lets `ExactKeys` compare it against the interface it mirrors. Widening to
 * `ObjectSchema<string>` here would make the drift check vacuous.
 */
export interface ObjectSchema<K extends string = string> {
  readonly kind: 'object';
  readonly keys: Readonly<Record<K, ConfigSchema>>;
}

export type ConfigSchema = LeafSchema | MapSchema | ObjectSchema<string>;

export const leaf: LeafSchema = { kind: 'leaf' };

/** Arbitrary operator-chosen keys (env var names, agent event names, request bodies). */
export function openMap(values: ConfigSchema = leaf): MapSchema {
  return { kind: 'map', values };
}

export function object<K extends Record<string, ConfigSchema>>(keys: K): ObjectSchema<Extract<keyof K, string>> {
  return { kind: 'object', keys };
}

/**
 * The goal capability claim, shared by all three declarative adapters.
 *
 * Closed on purpose and the most important node in every schema here: this is the object whose
 * typo is not merely confusing. A truthy `goalSupport` makes the capability getter return
 * `{ goals }`, so Mercury advertises support it cannot deliver. `goalSupport: { sett: "1.0.0" }`
 * is exactly that -- truthy, and empty of meaning.
 */
export const GOAL_SUPPORT_SCHEMA = object({
  set: leaf,
  track: leaf,
  tokenBudget: leaf,
  contract: leaf,
  gates: leaf,
  maxTurns: leaf,
});

export interface UnknownKey {
  /** Dotted path to the offending object, '' for the config root. */
  path: string;
  key: string;
  /** Closest recognised key at this level, when one is close enough to be a likely typo. */
  suggestion?: string;
}

/** How different a key may be from a known one and still be called a likely typo. */
const SUGGESTION_MAX_DISTANCE = 3;

function suggestionFor(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Suggest the nearest key rather than listing every key: the full list only gets longer, and a
  // single "did you mean" is the thing that actually shortens the fix.
  if (best === undefined) return undefined;
  if (bestDistance > SUGGESTION_MAX_DISTANCE) return undefined;
  // A long key tolerates one more typo than a short one before the suggestion stops being
  // trustworthy; `goalSuport` -> `goalSupport` must fire even though `description` is also close.
  if (bestDistance > Math.max(1, Math.ceil(best.length / 4))) return undefined;
  return best;
}

/**
 * Every key present in `value` but absent from `schema`, at any depth.
 *
 * Returns all of them rather than the first: a config with a typo usually has several, and
 * fixing one at a time across restarts is exactly the loop this exists to end.
 */
export function findUnknownKeys(value: unknown, schema: ConfigSchema, path = ''): UnknownKey[] {
  if (schema.kind === 'leaf') return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // Shape errors are the validator's business; this helper only answers "is this key known".
    return [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (schema.kind === 'map') {
    return entries.flatMap(([key, child]) => findUnknownKeys(child, schema.values, path ? `${path}.${key}` : key));
  }
  const known = Object.keys(schema.keys);
  return entries.flatMap(([key, child]): UnknownKey[] => {
    const at = path ? `${path}.${key}` : key;
    if (Object.prototype.hasOwnProperty.call(schema.keys, key)) {
      // Descend into the KNOWN key. This is the whole point of the recursion: `goalSupport` is
      // legal, and the typo is one level inside it. An implementation that only reports unknown
      // keys at the level it was handed would pass every top-level test and miss the case that
      // actually advertises a capability Mercury cannot deliver.
      return findUnknownKeys(child, schema.keys[key], at);
    }
    // Unknown key: report it, and do not descend. Its contents are not described by any schema,
    // so anything inside is unknowable -- and the key itself is the thing to fix first.
    return [{ path, key, suggestion: suggestionFor(key, known) }];
  });
}

/**
 * Throw with the offending key named and the nearest recognised key suggested.
 *
 * `label` prefixes the message so the operator knows which config file's schema applied, which
 * matters most when the file is in the wrong directory and is being validated by the wrong
 * adapter -- a real failure mode, since the three declarative directories sit side by side.
 */
export function assertNoUnknownKeys(value: unknown, schema: ConfigSchema, label: string): void {
  const unknown = findUnknownKeys(value, schema);
  if (unknown.length === 0) return;
  const where = (k: UnknownKey): string => (k.path ? `${k.path}.${k.key}` : k.key);
  const described = unknown.map((k) => {
    const at = where(k);
    return k.suggestion ? `${at} (did you mean '${k.suggestion}'?)` : at;
  });
  throw new Error(
    `${label}: unknown config ${unknown.length === 1 ? 'key' : 'keys'} ${described.join(', ')}. `
    + 'Unknown keys are rejected rather than ignored, because an ignored typo is read as a '
    + 'deliberate choice.',
  );
}

/**
 * Compile-time proof that a schema covers exactly the keys of the interface it mirrors.
 *
 * A hand-written schema drifts from a hand-written interface silently: add a field to the
 * interface, forget the schema, and every config using the new field starts failing to load --
 * a loud failure, but one that points at the config file rather than the code that changed.
 * The reverse (schema has a key the interface lacks) is worse and silent, because it accepts a
 * key nothing reads.
 */
export type ExactKeys<SchemaKeys extends keyof any, InterfaceKeys extends keyof any> =
  [Exclude<SchemaKeys, InterfaceKeys>] extends [never]
    ? [Exclude<InterfaceKeys, SchemaKeys>] extends [never]
      ? true
      : { missingFromSchema: Exclude<InterfaceKeys, SchemaKeys> }
    : { extraInSchema: Exclude<SchemaKeys, InterfaceKeys> };
