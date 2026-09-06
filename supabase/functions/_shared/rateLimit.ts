// supabase/functions/_shared/rateLimit.ts
//
// Simple in-memory, per-instance sliding-window rate limiter keyed by IP.
// Deliberately not a DB-backed limiter: `answer-proposal` is a
// low-stakes, kibbutz-scale, `verify_jwt = false` endpoint (ARCHITECTURE.md
// §8) and the token itself is unguessable (random 128-bit secret, ARCHITECTURE
// §8); this limiter's job is only to blunt naive brute-force/scripted abuse,
// not to be a security boundary on its own. Because each Edge Function
// instance/isolate keeps its own map, a distributed attacker sees a higher
// effective ceiling than the numbers below — acceptable for this app's scale.

interface Bucket {
  windowStartMs: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Returns true if `key` is allowed to proceed under `limit` requests per
 * `windowMs`, incrementing its counter as a side effect. Old buckets are
 * opportunistically dropped to avoid unbounded growth over the isolate's
 * lifetime.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number, nowMs = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
    buckets.set(key, { windowStartMs: nowMs, count: 1 });
    if (buckets.size > 10_000) pruneOldBuckets(nowMs, windowMs);
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function pruneOldBuckets(nowMs: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs >= windowMs) buckets.delete(key);
  }
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}
