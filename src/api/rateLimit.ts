// Tiny in-memory fixed-window rate limiter (no deps; Mercury.md section 24).
//
// Keyed by client IP (req.ip) plus a route-group label, and — when the request
// is authenticated — the resolved ownerId, so per-owner limits (e.g. run
// creation) do not share one pool across owners.
//
// Fixed window: each key gets a counter that resets at `resetAt`. Deliberately
// simple (no sliding window, no persistence).
//
// The map is HARD-BOUNDED (issue #144). It used to be described as "bounded in practice (unique
// IPs)" with a lazy sweep as a guard, and both halves of that were wrong: the sweep deleted only
// buckets whose window had ELAPSED, so when distinct-key churn outran the window it freed nothing,
// and it ran on every request that introduced a new key once past the threshold -- so the guard
// itself was the O(n) cost. Measured on this tree, 40,000 distinct keys inside one window, ms per
// request by range: 0.00037 (0-5k), 0.036 (5k-20k), 0.100 (20k-40k) -- a 271x spread between the
// cheapest and dearest range, 2520 ms in total. The architecture review measured the same shape at
// 2492 ms and called it a 163x slowdown; the ratio depends on which ranges you divide, so the total is
// the number that matters: it is quadratic, and it grows with the square of the key churn.

import type { NextFunction, Request, Response } from 'express';

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** Route-group label used in the key (e.g. 'auth-login', 'create-run'). */
  group?: string;
  /** Restrict to these HTTP methods (upper case); default: all methods. */
  methods?: string[];
  /**
   * Clock, injectable so the eviction ORDER can be tested. Defaults to Date.now.
   *
   * Without it every bucket in a test gets a resetAt within a millisecond or two of every other, so
   * "evict the soonest-expiring first" is indistinguishable from any other order -- ties make the sort
   * arbitrary. A mutation that evicted from the wrong end survived until this was added.
   */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Hard bound on distinct keys held at once. Reaching it does not reject requests -- it evicts.
 * Over-limit requests are still limited correctly by their own bucket; what the cap protects is
 * memory and per-request cost.
 */
const MAX_BUCKETS = 10_000;

/**
 * On hitting the cap, evict down to this fraction rather than to just under it. The gap is what
 * makes the eviction amortised: the scan runs once per (MAX_BUCKETS - target) new keys instead of
 * once per new key, which is the difference between linear and quadratic total cost.
 */
const LOW_WATER_FRACTION = 0.75;

export function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const methods = opts.methods ? new Set(opts.methods) : null;
  const clock = opts.now ?? Date.now;

  const evict = (now: number): void => {
    const target = Math.floor(MAX_BUCKETS * LOW_WATER_FRACTION);

    // 1. Free every bucket whose window has elapsed. Always safe, and the common case in a healthy
    //    process -- which is why this is tried first.
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    // Drop to the LOW-WATER mark here as well, not merely below the cap. Returning the moment a single
    // bucket had elapsed -- which is what this did -- reproduces the shape issue #144 describes whenever
    // keys churn slowly enough that roughly one window expires per new key: the map hovers at the cap,
    // every new key re-enters evict(), and the full scan runs once per request again. Evicting to the
    // mark is what makes BOTH branches amortised rather than only the churn case.
    if (buckets.size <= target) return;

    // 2. Still full, so nothing had expired: churn is outrunning the window, which is exactly the
    //    case the old sweep could not handle. Evict the buckets that expire SOONEST.
    //
    //    The trade is deliberate and should be stated plainly: evicting a live bucket resets that
    //    key's counter, so under extreme key churn an individual caller gets a slightly weaker limit.
    //    The alternative was the previous behaviour -- unbounded memory plus O(size) work per request.
    //    A marginally looser limit under a churn attack beats a request path that degrades 163x.
    const byExpiry = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of byExpiry) {
      if (buckets.size <= target) break;
      buckets.delete(key);
    }
  };

  type RateLimiter = ((req: Request, res: Response, next: NextFunction) => void) & {
    bucketCount(): number;
  };
  const handler: RateLimiter = function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (methods && !methods.has(req.method.toUpperCase())) {
      next();
      return;
    }
    const now = clock();
    // Owner scoping: req.auth is set by the auth middleware, which runs before
    // any route limiter. Unauthenticated keys use an empty owner segment.
    const owner = req.auth?.ownerId ?? '';
    const key = `${opts.group ?? 'default'}:${req.ip}:${owner}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= MAX_BUCKETS) evict(now);
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    next();
  };

  /**
   * Live bucket count, exposed for tests and for an operator gauge. The bound in issue #144 is a
   * property of this map's size, and a test cannot assert it from outside without this.
   */
  handler.bucketCount = (): number => buckets.size;
  return handler;
}
