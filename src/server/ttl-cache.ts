/**
 * Bounded TTL cache.
 *
 * Every cache in the server was a plain `Map` that checked a TTL on read but
 * never deleted anything, so entries accumulated for the life of the process.
 * Measured ~5MB retained per snapshot analysed; a long-running server taking
 * public repo URLs would OOM after a few thousand snapshots.
 *
 * Entries expire by TTL (per-entry, so callers can still ask for a short or
 * long freshness) and the map is capped by count, evicting oldest insertion
 * order first, so memory stays flat no matter how many keys arrive.
 */
export class TtlCache<V> {
  private map = new Map<string, { exp: number; value: V }>();

  constructor(
    private ttlMs: number,
    private max = 500
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.exp) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    // Re-insert so Map iteration order stays oldest-first for eviction.
    this.map.delete(key);
    this.map.set(key, { exp: Date.now() + ttlMs, value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}