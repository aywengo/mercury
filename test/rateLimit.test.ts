// The fixed-window rate limiter's own bounds (issue #144). Reached through the app elsewhere
// (auth.test.ts covers the 429 contract); this file covers the bucket map, which is invisible from
// outside the middleware.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/api/rateLimit.ts';
import type { NextFunction, Request, Response } from 'express';

const CAP = 10_000;

function req(ip: string): Request {
  return { method: 'GET', ip, headers: {} } as unknown as Request;
}
// A Response whose every method returns itself, so res.set(...).status(...).json(...) works.
const res = new Proxy({}, { get: () => () => res }) as unknown as Response;
const pass: NextFunction = () => {};

/** A distinct, routable-looking address for each i, so every request introduces a new key. */
function ip(i: number): string {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

test('the bucket map stays bounded past the cap, even when nothing has expired (issue #144)', () => {
  // The scenario from the finding: 3x the cap of DISTINCT keys inside ONE window, so no bucket ever
  // elapses. The old sweep deleted only elapsed buckets, so it freed nothing and the map grew without
  // bound while paying an O(size) scan per new key.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1_000, group: 'bound' });
  const N = CAP * 3;
  const CHUNK = 2_000;
  // Cost is asserted as a RATIO, not an absolute wall-clock bound. An earlier version said
  // "elapsed < 500 ms", which is a flake waiting to happen: this suite is known to fail spuriously
  // under parallel load (issue #165), and a threshold that only a slow machine can cross fails on the
  // machine that is already having a bad day. A ratio is self-calibrating -- both halves pay the same
  // load, so a loaded machine scales them together.
  //
  // The old sweep made cost per insert proportional to map size, so inserts late in the run were far
  // more expensive than inserts early on. Linear behaviour keeps the two comparable; quadratic blows
  // the ratio up by roughly the growth in size.
  const per: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    limiter(req(ip(i)), res, pass);
    per.push(performance.now() - t0);
  }

  assert.ok(limiter.bucketCount() <= CAP,
    `map must stay at or under the cap of ${CAP}, grew to ${limiter.bucketCount()}`);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const early = mean(per.slice(0, CHUNK));
  const late = mean(per.slice(-CHUNK));
  assert.ok(late < early * 20,
    `per-insert cost must not track map size: early ${early.toFixed(5)} ms vs late ${late.toFixed(5)} ms ` +
    `(ratio ${(late / early).toFixed(1)}x) -- the old O(size) sweep made this grow with the map`);
});

test('eviction drops LIVE buckets, and survivors keep their counters (issue #144)', () => {
  // The gap the old sweep could not close: when every bucket is unexpired, deleting only elapsed
  // buckets frees nothing. So fill past the cap inside one window and prove live buckets went.
  const MAX = 2;
  const limiter = createRateLimiter({ windowMs: 60_000, max: MAX, group: 'policy' });

  // CAP + 500 DISTINCT keys, all inside one 60s window: none of them has expired, so a sweep that
  // only removes elapsed buckets would leave the map at CAP + 500.
  const total = CAP + 500;
  for (let i = 0; i < total; i++) limiter(req(ip(i)), res, pass);
  assert.ok(limiter.bucketCount() <= CAP,
    `bounded at ${CAP} despite ${total} live distinct keys, got ${limiter.bucketCount()}`);

  // A survivor must still be limited by its OWN history, not handed a fresh budget. The last key
  // written has the latest resetAt, so it is the last candidate for eviction.
  //
  // It already has count=1 from the churn above, and max is 2. So: next request allowed (count 2),
  // the one after that refused (count 3). If eviction had reset the counter, BOTH would be allowed
  // and passed would be 2 -- which is exactly the failure this pins.
  const survivor = ip(total - 1);
  let passed = 0;
  const hit = () => limiter(req(survivor), res, () => { passed++; });
  hit();
  assert.equal(passed, 1, 'its 2nd request of the window is still within max');
  hit();
  assert.equal(passed, 1,
    'its 3rd request must be refused: the counter survived eviction rather than being reset');
});

test('normal limiting still works and reports Retry-After (issue #144 regression)', () => {
  // The bound must not change the contract the app relies on.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, group: 'contract' });
  const headers: Record<string, string> = {};
  let status = 0;
  const spyRes = {
    set: (k: string, v: string) => { headers[k] = v; return spyRes; },
    status: (c: number) => { status = c; return spyRes; },
    json: () => spyRes,
  } as unknown as Response;

  let passed = 0;
  for (let i = 0; i < 3; i++) limiter(req('198.51.100.9'), spyRes, () => { passed++; });
  assert.equal(passed, 2, 'exactly max requests pass per window');
  assert.equal(status, 429, 'the third is rejected');
  assert.ok(Number(headers['Retry-After']) >= 1, `Retry-After must be a positive number of seconds, got ${headers['Retry-After']}`);
});

test('methods filter still short-circuits before any bucket is created (issue #144 regression)', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, group: 'verbs', methods: ['POST'] });
  for (let i = 0; i < 50; i++) {
    limiter({ method: 'GET', ip: ip(i), headers: {} } as unknown as Request, res, pass);
  }
  assert.equal(limiter.bucketCount(), 0, 'a non-matching method must never allocate a bucket');
});

test('eviction removes the SOONEST-expiring buckets first (issue #144)', () => {
  // Deterministic only because the clock is injectable. Every bucket in a real run lands within a
  // millisecond or two of the next, so without this the sort order is arbitrary under ties and a
  // mutation that evicted from the wrong end passed every other test here -- it did.
  const MAX = 2;
  let t = 0;
  const limiter = createRateLimiter({ windowMs: 1_000, max: MAX, group: 'order', now: () => t });

  // The earliest-expiring key, created at t=0 so it resets at 1000.
  limiter(req('203.0.113.1'), res, pass); // count 1, resetAt 1000

  // Then 10k+ keys created at t=500, all resetting at 1500 -- all UNEXPIRED at t=500, all expiring
  // strictly LATER than the first key. This is what forces eviction.
  t = 500;
  for (let i = 0; i < CAP + 500; i++) limiter(req(ip(i)), res, pass);
  assert.ok(limiter.bucketCount() <= CAP, 'bounded');

  const attempts = (key: string): number => {
    let passed = 0;
    for (let i = 0; i < MAX + 1; i++) limiter(req(key), res, () => { passed++; });
    return passed;
  };

  // The earliest expirer was evicted, so it starts from a fresh budget: MAX of MAX+1 allowed.
  assert.equal(attempts('203.0.113.1'), MAX,
    'the soonest-expiring key must be the one evicted (fresh budget after eviction)');
  // A late expirer survived with its count of 1, so only one more request fits.
  assert.equal(attempts(ip(CAP + 499)), 1,
    'a later-expiring key must survive eviction with its counter intact');
});
test('eviction reaches the low-water mark even when SOME buckets had expired (issue #144)', () => {
  // The residual gap. Returning as soon as the map dipped below the CAP -- which is what an earlier
  // revision did after freeing the expired buckets -- leaves the map hovering AT the cap whenever keys
  // churn slowly enough that about one window expires per new key. Every new key then re-enters evict()
  // and pays the full scan again: the quadratic shape issue #144 reports, reached by a different route
  // than the churn case. Evicting to the low-water mark in BOTH branches is what amortises it, and the
  // observable consequence is that LIVE buckets go even though some buckets had already expired.
  const TARGET = Math.floor(CAP * 0.75);
  let now = 1_000;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1_000, group: 'mark', now: () => now });

  // Ten buckets created in an EARLIER window, then the map filled to the cap in the current one. So at
  // the moment of eviction exactly ten buckets have elapsed and the rest are live.
  for (let i = 0; i < 10; i++) limiter(req(ip(i)), res, pass);
  now += 60_001;
  for (let i = 10; i < CAP; i++) limiter(req(ip(i)), res, pass);
  assert.equal(limiter.bucketCount(), CAP, 'fixture: the map is exactly at the cap');

  limiter(req(ip(CAP)), res, pass); // one new key forces eviction

  assert.ok(limiter.bucketCount() <= TARGET + 1,
    `eviction must drop to the low-water mark ${TARGET}, not merely below the cap; left at ` +
    `${limiter.bucketCount()}`);
});
