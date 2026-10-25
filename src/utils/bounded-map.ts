/**
 * A Map with a size cap and a time to live, for state the SDK keeps per run or per trace on behalf of
 * callbacks that may never come: a run whose end the framework never reports would otherwise stay for the
 * life of the process. Past the cap the oldest entry goes; an entry older than the TTL is gone when next read
 * and swept as new ones arrive. `onEvict` is told of every entry that leaves other than by `delete`.
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, { value: V; at: number }>();
  private lastSweep = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly onEvict?: (key: K, value: V) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.clock() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      this.evicted(key, entry.value);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): this {
    const now = this.clock();
    this.entries.delete(key);
    this.entries.set(key, { value, at: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.evicted(oldest.value, entry.value);
    }
    if (now - this.lastSweep > Math.min(this.ttlMs, 60_000)) this.sweep(now);
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  values(): V[] {
    const now = this.clock();
    const out: V[] = [];
    for (const entry of this.entries.values()) if (now - entry.at <= this.ttlMs) out.push(entry.value);
    return out;
  }

  /** Live entries, oldest first. */
  entriesList(): Array<[K, V]> {
    const now = this.clock();
    const out: Array<[K, V]> = [];
    for (const [key, entry] of this.entries) if (now - entry.at <= this.ttlMs) out.push([key, entry.value]);
    return out;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    // Insertion order is age order, so the sweep stops at the first entry still alive.
    for (const [key, entry] of this.entries) {
      if (now - entry.at <= this.ttlMs) break;
      this.entries.delete(key);
      this.evicted(key, entry.value);
    }
  }

  private evicted(key: K, value: V): void {
    if (!this.onEvict) return;
    try {
      this.onEvict(key, value);
    } catch {
      // Eviction never fails the caller.
    }
  }
}
