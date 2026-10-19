// The authenticated caller, as the A2A boundary sees it (docs/a2a-design.md sections 6.1, 6.3).
//
// Mercury resolves credentials ONCE, app-wide, in the auth middleware (#140). The SDK is handed the
// result, never a second authentication path: `userBuilder` reads what that middleware already put
// on the request, and every A2A handler reads the owner from the call context rather than from
// anything the caller sent.

import type { User } from '@a2a-js/sdk/server';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { UnsupportedOperationError } from '@a2a-js/sdk/errors';

/**
 * The SDK's `User`, carrying Mercury's two facts about the caller.
 *
 * A class rather than a plain object because `User` is defined by getters, and a class is what
 * makes `instanceof` a real check: a handler that gets a context without Mercury's user behind it
 * must fail loudly, not read `undefined` as "no owner" and answer for nobody in particular.
 */
export class MercuryUser implements User {
  readonly ownerId: string;
  readonly isAdmin: boolean;

  constructor(ownerId: string, isAdmin: boolean) {
    this.ownerId = ownerId;
    this.isAdmin = isAdmin;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.ownerId;
  }
}

/** The caller, or a refusal. Never "no owner": an A2A request without an owner is a bug in the
 *  mount, and answering it would mean answering for the wrong one. */
export function requireUser(context: ServerCallContext): MercuryUser {
  const user = context.user;
  if (!(user instanceof MercuryUser)) {
    throw new UnsupportedOperationError('A2A request reached a handler without an authenticated Mercury owner.');
  }
  return user;
}
