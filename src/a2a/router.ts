// The A2A mount (docs/a2a-design.md sections 6.1, 6.8, 11 decision 3).
//
// Two things are mounted, and the split between them is the whole security shape of the surface:
//
//   - the public agent card, OUTSIDE authentication. It is the one thing an unauthenticated caller
//     may read, and it lists no skills. It has to be exempt explicitly rather than by a hole in the
//     auth middleware, so the exemption is this line and nothing else.
//   - the REST binding's routes, behind `requireAuth` -- the SAME gate /api uses, resolved by the
//     SAME credential resolver (#140). Mercury does not let the SDK bring its own authentication.
//     `requireAuth` alone is NOT enough (section 6.3): it accepts the admin token, and every handler
//     passes `isAdmin` through to RunService, so an admin token could read or cancel another owner's
//     task. `requireA2aCaller` refuses the admin owner and every bot owner on all A2A routes.
//
// The one A2A operation that creates a Run (`POST .../message:send`) also carries the SHARED
// Run-creation budget, so the A2A surface cannot fill the worker queue past the limit that
// `POST /api/runs` and the workflow route already enforce.
//
// The SDK's Express integration is a plain `RequestHandler` (`express` is an optional peer
// dependency satisfied by the Express 4 Mercury already runs), so the whole surface mounts on
// Mercury's existing server: no second framework, no Express major upgrade.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { UnauthenticatedUser, type User } from '@a2a-js/sdk/server';
import { agentCardHandler, restHandler, type UserBuilder } from '@a2a-js/sdk/server/express';
import { requireAuth } from '../api/auth.ts';
import { A2A_AGENT_CARD_PATH, A2A_PREFIX, BOT_OWNER_PREFIX, type A2aDeps } from './config.ts';
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

/**
 * Section 6.3: the admin owner and every bot owner are refused on ALL A2A routes.
 *
 * The refusal is Mercury's own 403, in the shape `requireAuth` already uses for its 401, because
 * this gate runs BEFORE the SDK's transport: the spec defines no authorization-error class, and
 * inventing one of its other errors for this would tell the caller the wrong thing.
 *
 * Exported so a test can mount exactly what the server mounts, rather than a near-copy that agrees
 * with this one today.
 */
export function requireA2aCaller(req: Request, res: Response, next: NextFunction): void {
  const auth = req.auth;
  if (!auth) {
    // Unreachable behind `requireAuth`. Kept explicit: this middleware is a security boundary, and
    // one that silently treats a missing owner as "not an admin" would be a hole, not a shortcut.
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  if (auth.isAdmin) {
    res.status(403).json({ error: 'admin credentials are not accepted on A2A routes' });
    return;
  }
  if (auth.ownerId.startsWith(BOT_OWNER_PREFIX)) {
    res.status(403).json({ error: 'bot credentials are not accepted on A2A routes' });
    return;
  }
  next();
}

/**
 * The SHARED Run-creation budget, applied to the one A2A operation that creates a Run.
 *
 * `SendMessage` writes the same queue as `POST /api/runs`, so it must draw on the same per-owner+IP
 * budget; without this, a caller submitting distinct message ids with `returnImmediately: true`
 * bypasses the limit that exists to keep the queue from filling.
 *
 * The check is on the path SUFFIX rather than on a literal path: the SDK mounts both `/message:send`
 * and its tenant form `/:tenant/message:send`, and those literals belong to the SDK. Every other
 * A2A POST (cancel, subscribe) is not Run creation and must not spend the budget -- a caller at the
 * limit has to stay able to cancel.
 *
 * The suffix is matched against a NORMALIZED path, because Express routes case-insensitively and
 * ignores a trailing slash by default (`caseSensitive` and `strict` are both false). `/MESSAGE:SEND`
 * and `/message:send/` therefore reach the SDK's send route and create a Run, so a check that
 * skipped them would leave the budget bypassable by spelling. Normalizing the same two ways is what
 * makes this a property of the ROUTE rather than of one way of writing it.
 */
function a2aCreateRunLimiter(limiter: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (req.method === 'POST' && path.endsWith('/message:send')) {
      limiter(req, res, next);
      return;
    }
    next();
  };
}

/** Mount the surface on an app. Kept here so the gate and the exemption cannot be applied in the
 *  wrong order by a caller, and so a test can mount exactly what the server mounts.
 *
 *  `createRunLimiter` is REQUIRED rather than optional: an optional one is how the A2A surface
 *  silently loses the budget, which is the finding this parameter exists to answer. */
export function mountA2a(
  app: { use: (path: string, ...handlers: RequestHandler[]) => unknown },
  deps: A2aDeps,
  options: { createRunLimiter: RequestHandler },
): void {
  const mount = createA2aMount(deps);
  app.use(A2A_AGENT_CARD_PATH, mount.card);
  app.use(A2A_PREFIX, requireAuth, requireA2aCaller, a2aCreateRunLimiter(options.createRunLimiter), mount.routes);
}
