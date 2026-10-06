import { Redis } from 'ioredis';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function redisReady(): boolean {
  return !!process.env.REDIS_URL;
}

let redis: Redis | null = null;
function redisClient(): Redis | null {
  if (!redisReady()) return null;
  try {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
    }
    return redis;
  } catch {
    return null;
  }
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window rate limiter. Redis-backed when REDIS_URL is set (fail-open),
 * in-memory otherwise. Keys are namespaced per bucket so limits compose.
 */
export async function rateLimit(
  key: string,
  max: number,
  windowSec: number
): Promise<RateResult> {
  const r = redisClient();
  if (r) {
    try {
      const k = `tm:rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, windowSec);
      return { ok: n <= max, remaining: Math.max(0, max - n), retryAfterSec: n <= max ? 0 : windowSec };
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { ok: true, remaining: max - 1, retryAfterSec: 0 };
  }
  b.count++;
  return {
    ok: b.count <= max,
    remaining: Math.max(0, max - b.count),
    retryAfterSec: b.count <= max ? 0 : Math.ceil((b.resetAt - now) / 1000),
  };
}

export function clientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

export function tooMany(result: RateResult): Response {
  return Response.json(
    { error: 'rate_limited', message: 'Too many requests — slow down.', retryAfter: result.retryAfterSec },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSec) } }
  );
}
