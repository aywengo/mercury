// Tiny in-memory fixed-window rate limiter (no deps; Mercury.md section 24).
//
// Keyed by client IP (req.ip) plus a route-group label, and — when the request
// is authenticated — the resolved ownerId, so per-owner limits (e.g. run
// creation) do not share one pool across owners.
//
// Fixed window: each key gets a counter that resets at `resetAt`. Deliberately
// simple (no sliding window, no persistence). The bucket map is bounded in
// practice (unique IPs); a lazy sweep on overflow guards against unbounded
// growth from many distinct clients.

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
}

interface Bucket {
  count: number;
  resetAt: number;
}

const SWEEP_THRESHOLD = 10_000;

export function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const methods = opts.methods ? new Set(opts.methods) : null;

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (methods && !methods.has(req.method.toUpperCase())) {
      next();
      return;
    }
    const now = Date.now();
    // Owner scoping: req.auth is set by the auth middleware, which runs before
    // any route limiter. Unauthenticated keys use an empty owner segment.
    const owner = req.auth?.ownerId ?? '';
    const key = `${opts.group ?? 'default'}:${req.ip}:${owner}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= SWEEP_THRESHOLD) sweep();
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
}
