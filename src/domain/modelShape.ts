/**
 * Model shape validation (#823, hardened in #832 r1): non-empty, <= 200 chars, no whitespace or
 * control characters (C0 and C1, via \p{Cc}). Applied to the CALLER value and to the RESOLVED
 * value - a preset-declared model must satisfy the same contract, because both reach argv or
 * session config. `label` names the origin in the error so an operator can tell which field
 * carried the bad value.
 *
 * Lives in src/domain/ (moved from runService.ts for #855): the dispatcher bot's candidate hard
 * filter must call the SAME check the server applies, imported, never copied, so the bot and the
 * server cannot drift. src/domain/ is the no-I/O layer the bot boundary already admits.
 */

import { ValidationError } from './errors.ts';

export function validateModelShape(model: string, label: string): void {
  if (typeof model !== 'string' || model.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (model.length > 200) {
    throw new ValidationError(`${label} must be at most 200 characters`);
  }
  // \p{Cc} covers C0 (U+0000-U+001F) AND C1 (U+007F-U+009F); \s covers unicode whitespace.
  // A leading '-' would reach three argv parsers as '--model -x' / '-m -x' (claude, hermes,
  // prime-agent), where it may be taken as a flag rather than a value. No real model id starts
  // with one (#849).
  if (model.startsWith('-')) {
    throw new ValidationError(`${label} must not start with '-' (it is passed as a command-line value)`);
  }
  if (new RegExp('\\p{Cc}', 'u').test(model) || /\s/u.test(model)) {
    throw new ValidationError(`${label} must not contain whitespace or control characters: ${JSON.stringify(model)}`);
  }
}
