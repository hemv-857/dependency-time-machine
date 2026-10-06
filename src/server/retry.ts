/**
 * Retry with exponential backoff and jitter, for transient upstream failures.
 *
 * Every external dependency here (GitHub, OSV, the npm registry) occasionally
 * 5xx, resets a connection, or times out. Without a retry a single blip fails the
 * whole snapshot and the user gets a dead permalink for a reason that has
 * nothing to do with their repo. Retrying only *transient* failures matters:
 * a 404 or a rate-limit must fail fast, or we hammer the API we are being
 * throttled by.
 *
 * ponytail: no queue, no circuit breaker, no metrics — just a bounded loop.
 */

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Return false to fail immediately without retrying. */
  retryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, waitMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default policy: network errors, 5xx, 408 and 429 are worth another go. */
export function isTransient(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; status?: number; statusCode?: number };
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  // fetch abort / network failure surface as a named TypeError or AbortError
  if (e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'FetchError') return true;
  const m = e.message || '';
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network/i.test(m)) return true;
  // never retry a deliberate timeout on our own abort — that means we gave up
  if (/aborted due to timeout/i.test(m)) return false;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 5000;
  const retryable = opts.retryable ?? isTransient;
  const nap = opts.sleep ?? sleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !retryable(err)) throw err;
      // full jitter: avoids a thundering herd when many workers fail at once
      const waitMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jittered = Math.round(waitMs / 2 + Math.random() * (waitMs / 2));
      opts.onRetry?.(attempt, err, jittered);
      await nap(jittered);
    }
  }
  throw lastErr;
}