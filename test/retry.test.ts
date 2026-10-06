import { describe, expect, it, vi } from 'vitest';
import { isTransient, withRetry } from '@/server/retry';

/** A transient blip should not kill a snapshot; a permanent failure must not be hammered. */
const noSleep = { sleep: async () => {} };

describe('isTransient', () => {
  it.each([
    [500, true], [502, true], [503, true], [429, true], [408, true],
    [404, false], [400, false], [403, false], [401, false],
  ])('status %i -> %s', (status, expected) => {
    expect(isTransient(Object.assign(new Error('x'), { status }))).toBe(expected);
  });

  it('treats network errors as transient', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
  });

  it('does not retry our own deliberate timeout', () => {
    expect(isTransient(new Error('The operation was aborted due to timeout'))).toBe(false);
  });

  it('treats a rate-limit error as permanent', () => {
    expect(isTransient(new Error('GitHub API rate limit exceeded. Set GITHUB_TOKEN to raise the limit.'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const sleep = vi.fn();
    expect(await withRetry(fn, { sleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and throws the last error', async () => {
    const err = Object.assign(new Error('still down'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { attempts: 3, ...noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a permanent error', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    await expect(withRetry(fn, noSleep)).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially and reports each retry', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await withRetry(fn, {
      attempts: 4,
      baseMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).catch(() => {});
    // full jitter: each wait is in (cap/2, cap]
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThanOrEqual(200);
    expect(waits[2]).toBeGreaterThanOrEqual(200);
    expect(waits[2]).toBeLessThanOrEqual(400);
  });

  it('caps the wait at maxMs', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await withRetry(fn, {
      attempts: 5, baseMs: 1000, maxMs: 1500,
      sleep: async (ms) => { waits.push(ms); },
    }).catch(() => {});
    expect(Math.max(...waits)).toBeLessThanOrEqual(1500);
  });

  it('honours a custom retryable predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('custom'));
    await withRetry(fn, { retryable: () => false, ...noSleep }).catch(() => {});
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with the attempt number', async () => {
    const seen: number[] = [];
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('a'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('b'), { status: 500 }))
      .mockResolvedValue('ok');
    await withRetry(fn, { ...noSleep, onRetry: (n) => seen.push(n) });
    expect(seen).toEqual([1, 2]);
  });
});