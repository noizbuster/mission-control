/**
 * Measured transcript row heights.
 *
 * Estimates seed the first window; once a mounted row reports a real OpenTUI
 * layout height, the cache prefers the measurement so subsequent windows track
 * viewport coverage more tightly than pure heuristics.
 *
 * Perf notes:
 * - `set` coalesces listener notifications to one microtask per burst so a
 *   stream of onResize callbacks does not thrash Solid memos.
 * - `retain` no-ops when the live id set is unchanged (reference equality of a
 *   fingerprint string).
 * - Hard cap drops the oldest entries if the table grows past the live window.
 */

export type TranscriptHeightCacheSnapshot = {
    readonly size: number;
    readonly generation: number;
};

/** Safety bound: live transcript store caps at 500 parts; leave headroom. */
export const TRANSCRIPT_HEIGHT_CACHE_MAX_ENTRIES = 640;

export type TranscriptHeightCacheOptions = {
    readonly maxEntries?: number;
    /** Inject schedule for tests; default queueMicrotask. */
    readonly schedulePublish?: (cb: () => void) => void;
};

/**
 * Mutable height table keyed by stable transcript part / legacy block id.
 * Framework-free so window math stays unit-testable.
 */
export class TranscriptHeightCache {
    private readonly heights = new Map<string, number>();
    private generation = 0;
    private readonly listeners = new Set<() => void>();
    private readonly maxEntries: number;
    private readonly schedulePublish: (cb: () => void) => void;
    private publishScheduled = false;
    private lastRetainFingerprint: string | undefined;

    constructor(options: TranscriptHeightCacheOptions = {}) {
        this.maxEntries = options.maxEntries ?? TRANSCRIPT_HEIGHT_CACHE_MAX_ENTRIES;
        this.schedulePublish =
            options.schedulePublish ??
            ((cb) => {
                queueMicrotask(cb);
            });
    }

    getGeneration(): number {
        return this.generation;
    }

    size(): number {
        return this.heights.size;
    }

    getSnapshot(): TranscriptHeightCacheSnapshot {
        return { size: this.heights.size, generation: this.generation };
    }

    /** Measured height when present; otherwise `fallback`. */
    get(id: string, fallback: number): number {
        const measured = this.heights.get(id);
        return measured === undefined ? fallback : measured;
    }

    has(id: string): boolean {
        return this.heights.has(id);
    }

    /**
     * Record a positive measured height. Returns true when the stored value
     * changed. Listener notify is coalesced to the next microtask.
     */
    set(id: string, height: number): boolean {
        if (!(height > 0) || !Number.isFinite(height)) return false;
        const next = Math.max(1, Math.round(height));
        if (this.heights.get(id) === next) return false;
        // Refresh insertion order for LRU-ish eviction (Map keeps insert order;
        // delete+set moves key to the end).
        if (this.heights.has(id)) this.heights.delete(id);
        this.heights.set(id, next);
        this.evictIfNeeded();
        this.generation += 1;
        this.scheduleNotify();
        return true;
    }

    /**
     * Drop ids that are no longer in the live store.
     * `fingerprint` should be a stable join of sorted ids; when equal to the
     * previous retain call this is a no-op.
     */
    retain(ids: ReadonlySet<string>, fingerprint?: string): void {
        if (fingerprint !== undefined && fingerprint === this.lastRetainFingerprint) {
            return;
        }
        if (fingerprint !== undefined) {
            this.lastRetainFingerprint = fingerprint;
        }
        let changed = false;
        for (const key of this.heights.keys()) {
            if (!ids.has(key)) {
                this.heights.delete(key);
                changed = true;
            }
        }
        if (changed) {
            this.generation += 1;
            this.scheduleNotify();
        }
    }

    clear(): void {
        if (this.heights.size === 0) return;
        this.heights.clear();
        this.lastRetainFingerprint = undefined;
        this.generation += 1;
        this.scheduleNotify();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private evictIfNeeded(): void {
        while (this.heights.size > this.maxEntries) {
            const oldest = this.heights.keys().next().value;
            if (oldest === undefined) return;
            this.heights.delete(oldest);
        }
    }

    private scheduleNotify(): void {
        if (this.publishScheduled) return;
        this.publishScheduled = true;
        this.schedulePublish(() => {
            this.publishScheduled = false;
            this.publish();
        });
    }

    private publish(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // ignore
            }
        }
    }
}

export function createTranscriptHeightCache(options?: TranscriptHeightCacheOptions): TranscriptHeightCache {
    return new TranscriptHeightCache(options);
}

/** Stable fingerprint for retain() short-circuiting. */
export function fingerprintTranscriptIds(ids: readonly string[]): string {
    if (ids.length === 0) return '';
    // ids are already in live order; joining is enough for equality checks.
    return ids.join('\0');
}
