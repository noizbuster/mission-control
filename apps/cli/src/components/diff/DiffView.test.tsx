import { describe, expect, it } from 'vitest';
import { type DiffKindStyle, DiffView, kindStyle, splitLineSpans, type TextSpan } from './DiffView.js';
import type { DiffLine } from './render-diff.js';

describe('kindStyle per-kind Ink styling', () => {
    it('styles added lines green', () => {
        expect(kindStyle('added')).toEqual({ color: 'green' });
    });

    it('styles removed lines red', () => {
        expect(kindStyle('removed')).toEqual({ color: 'red' });
    });

    it('dims context lines', () => {
        const style = kindStyle('context') satisfies DiffKindStyle;
        expect(style.dimColor).toBe(true);
        expect(style.color).toBeUndefined();
    });

    it('styles hunk and meta lines cyan', () => {
        expect(kindStyle('hunk')).toEqual({ color: 'cyan' });
        expect(kindStyle('meta')).toEqual({ color: 'cyan' });
    });
});

describe('splitLineSpans segment boundaries', () => {
    it('returns a single non-inverse span when there are no inverted segments', () => {
        const line: DiffLine = { kind: 'context', text: 'hello world' };
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([{ text: 'hello world', inverse: false }]);
    });

    it('splits a line into before/inverse/after spans around a single segment', () => {
        // text "foo bar", inverse [4,7) -> "foo " + "bar"(inv)
        const line: DiffLine = { kind: 'removed', text: 'foo bar', invertedSegments: [{ start: 4, end: 7 }] };
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([
            { text: 'foo ', inverse: false },
            { text: 'bar', inverse: true },
        ]);
    });

    it('keeps the trailing text after a segment as non-inverse', () => {
        // text "const x = computeValue();" inverse [10,22)
        const line: DiffLine = {
            kind: 'removed',
            text: 'const x = computeValue();',
            invertedSegments: [{ start: 10, end: 22 }],
        };
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([
            { text: 'const x = ', inverse: false },
            { text: 'computeValue', inverse: true },
            { text: '();', inverse: false },
        ]);
    });

    it('round-trips: concatenating all spans reconstructs the original text', () => {
        const line: DiffLine = {
            kind: 'added',
            text: 'const x = computeValueCached();',
            invertedSegments: [{ start: 10, end: 29 }],
        };
        const reconstructed = splitLineSpans(line)
            .map((span) => span.text)
            .join('');
        expect(reconstructed).toBe(line.text);
    });

    it('marks exactly the segment range as inverse and nothing else', () => {
        const line: DiffLine = { kind: 'removed', text: '  indented', invertedSegments: [{ start: 2, end: 10 }] };
        const spans = splitLineSpans(line);
        const inverseText = spans
            .filter((s) => s.inverse)
            .map((s) => s.text)
            .join('');
        const plainText = spans
            .filter((s) => !s.inverse)
            .map((s) => s.text)
            .join('');
        expect(inverseText).toBe('indented');
        expect(plainText).toBe('  ');
    });
});

describe('DiffView component export', () => {
    it('is a callable React component', () => {
        expect(typeof DiffView).toBe('function');
    });

    it('renders without throwing for a representative mixed line set', () => {
        const lines: readonly DiffLine[] = [
            { kind: 'meta', text: 'Target: a.ts (unique exact match)' },
            { kind: 'hunk', text: '@@ -1,1 +1,1 @@' },
            { kind: 'removed', text: 'foo bar', invertedSegments: [{ start: 4, end: 7 }] },
            { kind: 'added', text: 'foo baz', invertedSegments: [{ start: 4, end: 7 }] },
            { kind: 'context', text: 'unchanged' },
        ];
        // Rendering is validated structurally via the pure helpers above; this
        // guard ensures the component constructor does not throw for valid props.
        expect(() => DiffView({ lines })).not.toThrow();
    });
});
