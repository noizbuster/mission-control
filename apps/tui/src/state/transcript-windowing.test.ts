import { describe, expect, it } from 'vitest';
import {
    anchorIndexForTranscriptOffset,
    DEFAULT_TRANSCRIPT_RENDER_LIMIT,
    estimateAnchorIndex,
    formatHiddenTranscriptBanner,
    MAX_TRANSCRIPT_RENDER_LIMIT,
    MIN_TRANSCRIPT_RENDER_LIMIT,
    normalizeTranscriptRenderLimit,
    selectTranscriptWindow,
    selectTranscriptWindowByHeight,
    transcriptWindowSpacerHeights,
} from './transcript-windowing';

describe('normalizeTranscriptRenderLimit', () => {
    it('defaults and clamps to the supported band', () => {
        expect(normalizeTranscriptRenderLimit(undefined)).toBe(DEFAULT_TRANSCRIPT_RENDER_LIMIT);
        expect(normalizeTranscriptRenderLimit(Number.NaN)).toBe(DEFAULT_TRANSCRIPT_RENDER_LIMIT);
        expect(normalizeTranscriptRenderLimit(1)).toBe(MIN_TRANSCRIPT_RENDER_LIMIT);
        expect(normalizeTranscriptRenderLimit(10_000)).toBe(MAX_TRANSCRIPT_RENDER_LIMIT);
        expect(normalizeTranscriptRenderLimit(42.9)).toBe(42);
    });
});

describe('estimateAnchorIndex', () => {
    it('maps top/bottom scroll ratios onto the full list', () => {
        expect(estimateAnchorIndex({ totalCount: 100, scrollY: 0, viewportHeight: 20, scrollHeight: 200 })).toBe(0);
        expect(estimateAnchorIndex({ totalCount: 100, scrollY: 180, viewportHeight: 20, scrollHeight: 200 })).toBe(99);
        expect(estimateAnchorIndex({ totalCount: 100, scrollY: 90, viewportHeight: 20, scrollHeight: 200 })).toBe(50);
    });

    it('returns the last row when there is no scroll range', () => {
        expect(estimateAnchorIndex({ totalCount: 10, scrollY: 0, viewportHeight: 40, scrollHeight: 30 })).toBe(9);
    });
});

describe('virtual transcript coordinates', () => {
    it('maps a half-page move from a 500-row tail to nearby logical rows', () => {
        const totalCount = 500;
        const viewportRows = 24;
        const halfPageRows = 12;

        const anchor = anchorIndexForTranscriptOffset({
            totalCount,
            offsetRows: totalCount - viewportRows - halfPageRows,
            heightAt: () => 1,
        });

        expect(anchor).toBe(464);
        expect(anchor).toBeGreaterThan(450);
    });

    it('uses row heights rather than a list-wide ratio for mixed-height offsets', () => {
        const heights = Array.from({ length: 500 }, (_, index) => (index % 11 === 0 ? 4 : 1));
        const fullHeight = heights.reduce((total, height) => total + height, 0);
        const offsetRows = fullHeight - 24 - 12;
        let expected = 0;
        let remaining = offsetRows;
        while (expected < heights.length - 1 && remaining >= heights[expected]!) {
            remaining -= heights[expected]!;
            expected += 1;
        }

        const anchor = anchorIndexForTranscriptOffset({
            totalCount: heights.length,
            offsetRows,
            heightAt: (index) => heights[index]!,
        });

        expect(anchor).toBe(expected);
        expect(anchor).toBeGreaterThan(450);
    });

    it('preserves full logical height with inert prefix and suffix spacers', () => {
        const parts = Array.from({ length: 500 }, (_, index) => ({ index, height: index % 7 === 0 ? 3 : 1 }));
        const window = selectTranscriptWindowByHeight({
            parts,
            limit: 80,
            viewportRows: 24,
            heightAt: (part) => part.height,
        });
        const spacers = transcriptWindowSpacerHeights({
            parts,
            window,
            heightAt: (part) => part.height,
        });
        const visibleHeight = window.visibleParts.reduce((total, part) => total + part.height, 0);
        const fullHeight = parts.reduce((total, part) => total + part.height, 0);

        expect(window.startIndex).toBe(420);
        expect(spacers.beforeRows + visibleHeight + spacers.afterRows).toBe(fullHeight);
    });
});

describe('selectTranscriptWindow', () => {
    it('returns the full list when under the limit', () => {
        const parts = ['a', 'b', 'c'];
        const window = selectTranscriptWindow(parts, 80);
        expect(window).toEqual({
            startIndex: 0,
            endIndex: 3,
            visibleParts: parts,
            hiddenBefore: 0,
            hiddenAfter: 0,
            totalCount: 3,
            anchorIndex: 2,
        });
        expect(window.visibleParts).toBe(parts);
    });

    it('keeps a sticky-bottom tail when no anchor (or near end) is given', () => {
        const parts = Array.from({ length: 100 }, (_, i) => `p${i}`);
        const window = selectTranscriptWindow(parts, 40);
        expect(window.totalCount).toBe(100);
        expect(window.hiddenBefore).toBe(60);
        expect(window.hiddenAfter).toBe(0);
        expect(window.startIndex).toBe(60);
        expect(window.endIndex).toBe(100);
        expect(window.visibleParts).toHaveLength(40);
        expect(window.visibleParts[0]).toBe('p60');
        expect(window.visibleParts.at(-1)).toBe('p99');
    });

    it('centers a bidirectional window on an earlier anchor', () => {
        const parts = Array.from({ length: 100 }, (_, i) => `p${i}`);
        const window = selectTranscriptWindow(parts, 40, 20);
        expect(window.visibleParts).toHaveLength(40);
        expect(window.startIndex).toBeLessThanOrEqual(20);
        expect(window.endIndex).toBeGreaterThan(20);
        expect(window.hiddenBefore).toBe(window.startIndex);
        expect(window.hiddenAfter).toBe(100 - window.endIndex);
        expect(window.hiddenAfter).toBeGreaterThan(0);
        expect(window.visibleParts).toContain('p20');
    });
});

describe('formatHiddenTranscriptBanner', () => {
    it('omits the banner when nothing is hidden', () => {
        expect(formatHiddenTranscriptBanner(0)).toBeUndefined();
        expect(formatHiddenTranscriptBanner(0, 0)).toBeUndefined();
    });

    it('reports earlier and newer hidden counts', () => {
        expect(formatHiddenTranscriptBanner(1)).toContain('1 earlier row');
        expect(formatHiddenTranscriptBanner(12)).toContain('12 earlier rows');
        expect(formatHiddenTranscriptBanner(5, 3)).toContain('↓ 3 newer rows');
    });
});

describe('selectTranscriptWindowByHeight', () => {
    it('uses height budget around an early anchor', () => {
        const parts = Array.from({ length: 100 }, (_, i) => ({ id: i, h: i % 5 === 0 ? 8 : 2 }));
        const window = selectTranscriptWindowByHeight({
            parts,
            limit: 40,
            anchorIndex: 10,
            viewportRows: 24,
            heightAt: (part) => part.h,
        });
        expect(window.hiddenAfter).toBeGreaterThan(0);
        expect(window.visibleParts.some((p) => p.id === 10)).toBe(true);
        expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(40);
    });
});
