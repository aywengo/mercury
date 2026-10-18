// The A2A mount (docs/a2a-design.md sections 6.1, 6.8, 11 decision 3).
//
// Two things are mounted, and the split between them is the whole security shape of the surface:
//
//   - the public agent card, OUTSIDE authentication. It is the one thing an unauthenticated caller
//     may read, and it lists no skills. It has to be exempt explicitly rather than by a hole in the
//     auth middleware, so the exemption is this line and nothing else.
//   - the REST binding's routes, behind `requireAuth` -- the SAME gate /api uses, resolved by the
//     SAME credential resolver (#140). Mercury does not let the SDK bring its own authentication.
//
// The SDK's Express integration is a plain `RequestHandler` (`express` is an optional peer
// dependency satisfied by the Express 4 Mercury already runs), so the whole surface mounts on
// Mercury's existing server: no second framework, no Express major upgrade.

import type { Request, RequestHandler } from 'express';
import { UnauthenticatedUser, type User } from '@a2a-js/sdk/server';
import { agentCardHandler, restHandler, type UserBuilder } from '@a2a-js/sdk/server/express';
import { requireAuth } from '../api/auth.ts';
import { A2A_AGENT_CARD_PATH, A2A_PREFIX, type A2aDeps } from './config.ts';
import { createA2aRequestHandler } from './requestHandler.ts';
import { MercuryUser } from './user.ts';

export interface A2aMount {
  /** Serves the public card. Mount OUTSIDE `requireAuth` (section 6.8). */
  card: RequestHandler;
  /** Serves the REST binding's routes. Mount BEHIND `requireAuth` (section 6.1). */
  routes: RequestHandler;
}

/** The card path, exported so the composition root mounts the exemption and the routes from one
 *  source rather than from two string literals that can drift apart. */
export { A2A_AGENT_CARD_PATH, A2A_PREFIX };

export function createA2aMount(deps: A2aDeps): A2aMount {
  const requestHandler = createA2aRequestHandler(deps);

  // The SDK is handed the caller the auth middleware ALREADY resolved; it never authenticates. An
  // unauthenticated request reaches here only if the mount forgot its gate, and it is answered as
  // what it is -- unauthenticated -- rather than as some owner's request.
  const userBuilder: UserBuilder = async (req: Request): Promise<User> => {
    const auth = (req as Request & { auth?: { ownerId: string; isAdmin: boolean } }).auth;
    return auth ? new MercuryUser(auth.ownerId, auth.isAdmin) : new UnauthenticatedUser();
  };

  return {
    card: agentCardHandler({ agentCardProvider: requestHandler }),
    // `legacyCompat` is deliberately absent: v0.3 compatibility is opt-in in the SDK and Mercury
    // does not serve v0.3 (section 5). Leaving it off is what makes a v0.3-shaped or versionless
    // request fail closed instead of being translated.
    routes: restHandler({ requestHandler, userBuilder }),
  };
}

/** Mount the surface on an app. Kept here so the gate and the exemption cannot be applied in the
 *  wrong order by a caller, and so a test can mount exactly what the server mounts. */
export function mountA2a(app: { use: (path: string, ...handlers: RequestHandler[]) => unknown }, deps: A2aDeps): void {
  const mount = createA2aMount(deps);
  app.use(A2A_AGENT_CARD_PATH, mount.card);
  app.use(A2A_PREFIX, requireAuth, mount.routes);
}
