import { describe, expect, it } from 'vitest';
import {
    createTerminalViewportCache,
    DEFAULT_TERMINAL_VIEWPORT,
    normalizeTerminalViewport,
    type OpenTuiTerminalDimensions,
    type TerminalViewport,
} from './terminal-viewport.js';

type FallbackCase = {
    readonly label: string;
    readonly dimensions: OpenTuiTerminalDimensions;
    readonly expected: TerminalViewport;
};

describe('normalizeTerminalViewport', () => {
    it('passes through positive integer OpenTUI dimensions', () => {
        // Given: OpenTUI reports positive integer terminal dimensions.
        const dimensions = { width: 120, height: 40 };

        // When: the viewport adapter normalizes the renderer shape.
        const viewport = normalizeTerminalViewport(dimensions);

        // Then: the terminal cell dimensions pass through as columns and rows.
        expect(viewport).toEqual({ columns: 120, rows: 40 });
    });

    const fallbackCases = [
        { label: 'missing', dimensions: {}, expected: DEFAULT_TERMINAL_VIEWPORT },
        { label: 'zero', dimensions: { width: 0, height: 0 }, expected: DEFAULT_TERMINAL_VIEWPORT },
        { label: 'negative', dimensions: { width: -1, height: -24 }, expected: DEFAULT_TERMINAL_VIEWPORT },
        { label: 'non-integer', dimensions: { width: 80.5, height: 24.5 }, expected: DEFAULT_TERMINAL_VIEWPORT },
        {
            label: 'NaN',
            dimensions: { width: Number.NaN, height: Number.NaN },
            expected: DEFAULT_TERMINAL_VIEWPORT,
        },
    ] satisfies readonly FallbackCase[];

    it.each(fallbackCases)('falls back safely for $label dimensions', ({ dimensions, expected }) => {
        // Given: OpenTUI reports dimensions that cannot form a positive integer viewport.
        // When: the viewport adapter normalizes them.
        const viewport = normalizeTerminalViewport(dimensions);

        // Then: the deterministic fallback prevents a zero, negative, NaN, or fractional layout.
        expect(viewport).toEqual(expected);
    });

    it('falls back per axis while preserving a valid sibling dimension', () => {
        // Given: only one OpenTUI dimension is invalid.
        const dimensions = { width: 100, height: 0 };

        // When: the viewport adapter normalizes the mixed-quality input.
        const viewport = normalizeTerminalViewport(dimensions);

        // Then: the valid width survives and only the invalid height uses fallback rows.
        expect(viewport).toEqual({ columns: 100, rows: 24 });
    });
});

describe('createTerminalViewportCache', () => {
    it('returns the same normalized object for duplicate dimensions', () => {
        // Given: a viewport cache at the helper boundary.
        const normalize = createTerminalViewportCache();

        // When: the same logical viewport is normalized twice.
        const first = normalize({ width: 120, height: 40 });
        const second = normalize({ width: 120, height: 40 });

        // Then: duplicate dimensions reuse the exact object reference.
        expect(second).toBe(first);
    });

    it('dedupes different malformed inputs that normalize to the same fallback viewport', () => {
        // Given: a viewport cache has seen the fallback shape.
        const normalize = createTerminalViewportCache();

        // When: two different malformed inputs normalize to the same fallback dimensions.
        const first = normalize({ width: 0, height: 0 });
        const second = normalize({});

        // Then: subscribers can treat the repeated fallback as unchanged.
        expect(second).toBe(first);
    });

    it('updates when a resize changes from 120x40 to 80x24', () => {
        // Given: a cached viewport seeded with a large terminal.
        const normalize = createTerminalViewportCache();
        const large = normalize({ width: 120, height: 40 });

        // When: OpenTUI reports a smaller terminal.
        const resized = normalize({ width: 80, height: 24 });
        const repeated = normalize({ width: 80, height: 24 });

        // Then: the resize publishes a fresh object, and repeated 80x24 inputs are deduped.
        expect(resized).toEqual({ columns: 80, rows: 24 });
        expect(resized).not.toBe(large);
        expect(repeated).toBe(resized);
    });
});
