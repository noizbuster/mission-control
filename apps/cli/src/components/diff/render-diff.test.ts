import { describe, expect, it } from 'vitest';
import { renderDiff } from './render-diff.js';

describe('renderDiff classification', () => {
    it('returns an empty array for empty input', () => {
        expect(renderDiff('')).toEqual([]);
    });

    it('classifies a @@ hunk header as hunk', () => {
        const out = renderDiff('@@ -1,2 +1,2 @@');
        expect(out).toEqual([{ kind: 'hunk', text: '@@ -1,2 +1,2 @@' }]);
    });

    it('classifies --- /+++ /Target: as meta', () => {
        const out = renderDiff(['--- a/src.ts', '+++ b/src.ts', 'Target: src.ts (unique exact match)'].join('\n'));
        expect(out).toHaveLength(3);
        expect(out.every((line) => line.kind === 'meta')).toBe(true);
        const [first, second, third] = out;
        expect(first?.text).toBe('--- a/src.ts');
        expect(second?.text).toBe('+++ b/src.ts');
        expect(third?.text).toBe('Target: src.ts (unique exact match)');
    });

    it('classifies non-diff prose as context lines without throwing', () => {
        const out = renderDiff('just some prose\nanother line');
        expect(out).toEqual([
            { kind: 'context', text: 'just some prose' },
            { kind: 'context', text: 'another line' },
        ]);
    });

    it('classifies a context line (leading space) stripping the marker', () => {
        const out = renderDiff(' unchanged line');
        expect(out).toEqual([{ kind: 'context', text: 'unchanged line' }]);
    });
});

describe('renderDiff intra-line word highlighting', () => {
    it('marks only the changed token on a single removed+added edit', () => {
        const out = renderDiff(['-foo bar', '+foo baz'].join('\n'));
        expect(out).toHaveLength(2);

        const [removed, added] = out;
        expect(removed?.kind).toBe('removed');
        expect(added?.kind).toBe('added');

        // Removed: text "foo bar", inverse only on "bar" -> [4,7).
        expect(removed?.text).toBe('foo bar');
        expect(removed?.invertedSegments).toEqual([{ start: 4, end: 7 }]);

        // Added: text "foo baz", inverse only on "baz" -> [4,7).
        expect(added?.text).toBe('foo baz');
        expect(added?.invertedSegments).toEqual([{ start: 4, end: 7 }]);
    });

    it('does NOT invert the common prefix "foo "', () => {
        const [removed] = renderDiff(['-foo bar', '+foo baz'].join('\n'));
        const segment = removed?.invertedSegments?.[0];
        // The inverse range must start at or after the "foo " prefix (offset 4),
        // never covering offset 0..4.
        expect(segment?.start).toBe(4);
        expect(segment?.end).toBe(7);
    });

    it('produces no inverted segments for a multi-line add/remove block', () => {
        const out = renderDiff(['-line one', '-line two', '+line three', '+line four'].join('\n'));
        expect(out).toHaveLength(4);
        for (const line of out) {
            expect(line.invertedSegments).toBeUndefined();
        }
        expect(out[0]?.kind).toBe('removed');
        expect(out[1]?.kind).toBe('removed');
        expect(out[2]?.kind).toBe('added');
        expect(out[3]?.kind).toBe('added');
    });

    it('strips leading whitespace from the first changed part so indentation is not highlighted', () => {
        const out = renderDiff(['-  indented', '+  Indented'].join('\n'));
        const [removed] = out;
        // text keeps the leading spaces; only "indented" is inverse -> [2, 10).
        expect(removed?.text).toBe('  indented');
        expect(removed?.invertedSegments).toEqual([{ start: 2, end: 10 }]);
    });

    it('expands tabs to three spaces before computing segments', () => {
        const out = renderDiff(['-\tcode', '+\tdone'].join('\n'));
        const [removed] = out;
        expect(removed?.text).toBe('   code');
        expect(removed?.invertedSegments).toEqual([{ start: 3, end: 7 }]);
    });

    it('handles a pure deletion (removed with no following added) without segments', () => {
        const out = renderDiff(['-gone line', ' context after'].join('\n'));
        const [removed, ctx] = out;
        expect(removed).toEqual({ kind: 'removed', text: 'gone line' });
        expect(ctx).toEqual({ kind: 'context', text: 'context after' });
    });
});

describe('renderDiff real mctrl file.edit preview shape', () => {
    it('parses a full renderFileEditPreview output with intra-line highlighting', () => {
        // Exact shape produced by renderFileEditPreview in interactive-coding-tool-preview.ts.
        const diff = [
            'Target: src/app.ts (unique exact match)',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '-const x = computeValue();',
            '+const x = computeValueCached();',
        ].join('\n');
        const out = renderDiff(diff);

        expect(out.map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'removed', 'added']);

        const removed = out[3];
        const added = out[4];
        // diffWords splits at the changed identifier; "computeValue" is inverse.
        expect(removed?.text).toBe('const x = computeValue();');
        expect(removed?.invertedSegments).toEqual([{ start: 10, end: 22 }]);
        expect(added?.text).toBe('const x = computeValueCached();');
        expect(added?.invertedSegments).toEqual([{ start: 10, end: 28 }]);
    });
});
