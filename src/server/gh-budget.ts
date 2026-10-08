import { childLogger } from './log';

const log = childLogger({ mod: 'gh-budget' });

/**
 * Global token bucket over outbound GitHub API calls.
 *
 * The per-IP rate limiter stops one client hammering this service. It does not
 * stop the *service* from draining its own GITHUB_TOKEN quota: many clients
 * behind different IPs, a crawler, or a single client cycling addresses can all
 * exhaust the hourly budget, and once it is gone every snapshot fails until
 * GitHub resets. This is the ceiling that keeps the deployment usable.
 *
 * ponytail: token bucket, no circuit breaker and no metrics.
 */

// read lazily, not at module load: env can be set after import, and a frozen
// constant here is impossible to reconfigure or test
const capacity = () => Number(process.env.TM_GITHUB_BUDGET || 4000);
const refillPerMin = () => Number(process.env.TM_GITHUB_BUDGET_REFILL || 70);

interface Bucket {
  tokens: number;
  last: number;
}

const globalForBucket = globalThis as unknown as { __tmGhBudget?: Bucket };

function bucket(): Bucket {
  if (!globalForBucket.__tmGhBudget) {
    globalForBucket.__tmGhBudget = { tokens: capacity(), last: Date.now() };
    log.info({ capacity: capacity(), refillPerMin: refillPerMin() }, 'github api budget armed');
  }
  return globalForBucket.__tmGhBudget;
}

function refill(b: Bucket, now = Date.now()): void {
  const elapsedMin = (now - b.last) / 60_000;
  if (elapsedMin <= 0) return;
  b.tokens = Math.min(capacity(), b.tokens + elapsedMin * refillPerMin());
  b.last = now;
}

export interface Budget {
  ok: boolean;
  remaining: number;
  /** seconds until at least one token is available */
  retryAfterSec: number;
  cap: number;
}

export function budgetStatus(now = Date.now()): Budget {
  const b = bucket();
  refill(b, now);
  const waitMs = b.tokens < 1 ? ((1 - b.tokens) / Math.max(refillPerMin(), 0.0001)) * 60_000 : 0;
  return {
    ok: b.tokens >= 1,
    remaining: Math.floor(b.tokens),
    retryAfterSec: waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : 0,
    cap: capacity(),
  };
}

/** Take one token. Returns false when the budget for this window is spent. */
export function takeToken(now = Date.now()): boolean {
  const b = bucket();
  refill(b, now);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function resetBudget(): void {
  globalForBucket.__tmGhBudget = { tokens: capacity(), last: Date.now() };
}