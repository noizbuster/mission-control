import { describe, expect, it, vi } from 'vitest';
import {
    createTranscriptHeightCache,
    fingerprintTranscriptIds,
    TRANSCRIPT_HEIGHT_CACHE_MAX_ENTRIES,
} from './transcript-height-cache';

describe('TranscriptHeightCache', () => {
    it('falls back until a positive measurement is stored', () => {
        const cache = createTranscriptHeightCache({
            schedulePublish: (cb) => {
                cb();
            },
        });
        expect(cache.get('a', 3)).toBe(3);
        expect(cache.set('a', 7)).toBe(true);
        expect(cache.get('a', 3)).toBe(7);
        expect(cache.set('a', 7)).toBe(false);
        expect(cache.set('a', 0)).toBe(false);
    });

    it('coalesces listener notifications within one scheduled flush', () => {
        const pending: Array<() => void> = [];
        const cache = createTranscriptHeightCache({
            schedulePublish: (cb) => {
                pending.push(cb);
            },
        });
        const listener = vi.fn();
        cache.subscribe(listener);
        cache.set('a', 4);
        cache.set('b', 5);
        expect(listener).not.toHaveBeenCalled();
        expect(pending).toHaveLength(1);
        pending[0]?.();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('retain no-ops on identical fingerprints and drops missing ids', () => {
        const cache = createTranscriptHeightCache({
            schedulePublish: (cb) => {
                cb();
            },
        });
        cache.set('a', 4);
        cache.set('b', 5);
        const fp = fingerprintTranscriptIds(['a']);
        cache.retain(new Set(['a']), fp);
        expect(cache.has('b')).toBe(false);
        const gen = cache.getGeneration();
        cache.retain(new Set(['a']), fp);
        expect(cache.getGeneration()).toBe(gen);
    });

    it('evicts oldest entries past the max cap', () => {
        const cache = createTranscriptHeightCache({
            maxEntries: 3,
            schedulePublish: (cb) => {
                cb();
            },
        });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.set('d', 4);
        expect(cache.size()).toBe(3);
        expect(cache.has('a')).toBe(false);
        expect(cache.has('d')).toBe(true);
        expect(TRANSCRIPT_HEIGHT_CACHE_MAX_ENTRIES).toBeGreaterThan(3);
    });
});
