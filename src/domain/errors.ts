/**
 * Error classes that carry an intended HTTP status (issue #66).
 *
 * Before these existed, every route wrapped its handler in `catch { res.status(400).json({error:
 * err.message}) }`. That was wrong twice over:
 *
 *   - A SQLite failure or a broken state-machine invariant was reported as a 400 *client* error,
 *     telling callers they had made a mistake when the server had, and telling monitoring the
 *     wrong thing.
 *   - `err.message` was echoed verbatim, so internal text -- absolute filesystem paths, driver
 *     messages, constraint internals -- reached the browser.
 *
 * The mapping rule is deliberately fail-safe: a recognised class gets its own status and its own
 * message, and ANYTHING ELSE becomes a 500 with a generic body. So forgetting to classify a new
 * throw leaks nothing; it just reports less. The inverse (defaulting to 400-with-message, as
 * before) leaks by default.
 *
 * Lives in `domain/` because it is pure -- no I/O -- and both the service layer and the API layer
 * need it.
 */

/** The request was malformed or asked for something that does not exist as input -> 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** The resource is absent, or absent *to this caller* -> 404.
 *
 * Owner-scoping must surface as 404 rather than 403 so that a foreign run is indistinguishable
 * from a nonexistent one (AGENTS.md: "non-admin callers see only their Runs; 404, not 403"). A
 * 403 would confirm the run exists and leak its existence to other owners.
 */
export class NotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The resource exists and the caller may touch it, but its current state forbids this -> 409.
 *
 * Cancelling a finished run or submitting input to a run that is not waiting are the cases.
 * These are not client mistakes in the validation sense -- the same request would succeed a
 * moment later against a different state -- so 409 rather than 400, and clients can distinguish
 * "fix your payload" from "retry later / this is done".
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
