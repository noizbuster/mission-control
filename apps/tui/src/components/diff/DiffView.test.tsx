/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { CHAT_DIFF_ADDED, CHAT_DIFF_REMOVED, CHAT_SECONDARY, CHAT_TEXT_MUTED } from '../chat-theme';
import { type DiffKindStyle, DiffView, kindStyle, splitLineSpans, type TextSpan } from './DiffView';
import { type DiffLine, renderDiff } from './render-diff';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./DiffView.tsx', import.meta.url)), 'utf-8');

describe('kindStyle per-kind styling', () => {
    it('styles added lines green', () => {
        expect(kindStyle('added')).toEqual({ fg: CHAT_DIFF_ADDED });
    });

    it('styles removed lines red', () => {
        expect(kindStyle('removed')).toEqual({ fg: CHAT_DIFF_REMOVED });
    });

    it('dims context lines', () => {
        const style = kindStyle('context') satisfies DiffKindStyle;
        expect(style.dim).toBe(true);
        expect(style.fg).toBe(CHAT_TEXT_MUTED);
    });

    it('styles hunk and meta lines cyan', () => {
        expect(kindStyle('hunk')).toEqual({ fg: CHAT_SECONDARY });
        expect(kindStyle('meta')).toEqual({ fg: CHAT_SECONDARY });
    });
});

describe('splitLineSpans segment boundaries', () => {
    it('returns a single non-inverse span when there are no inverted segments', () => {
        const line: DiffLine = { kind: 'context', text: 'hello world' };
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([{ text: 'hello world', inverse: false }]);
    });

    it('splits a line into before/inverse/after spans around a single segment', () => {
        const line = renderDiff(['-foo bar', '+foo baz'].join('\n')).at(0);
        if (line === undefined) {
            throw new Error('Expected the removed row to be rendered');
        }
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([
            { text: '-foo ', inverse: false },
            { text: 'bar', inverse: true },
        ]);
    });

    it('keeps the trailing text after a segment as non-inverse', () => {
        const line: DiffLine = {
            kind: 'removed',
            text: '-const x = computeValue();',
            invertedSegments: [{ start: 11, end: 23 }],
        };
        expect(splitLineSpans(line)).toEqual<TextSpan[]>([
            { text: '-const x = ', inverse: false },
            { text: 'computeValue', inverse: true },
            { text: '();', inverse: false },
        ]);
    });

    it('round-trips: concatenating all spans reconstructs the original text', () => {
        const line = renderDiff(['-foo bar', '+foo baz'].join('\n')).at(1);
        if (line === undefined) {
            throw new Error('Expected the added row to be rendered');
        }
        const reconstructed = splitLineSpans(line)
            .map((span) => span.text)
            .join('');
        expect(reconstructed).toBe('+foo baz');
        expect(reconstructed).toBe(line.text);
    });

    it('marks exactly the segment range as inverse and nothing else', () => {
        const line: DiffLine = { kind: 'removed', text: '-  indented', invertedSegments: [{ start: 3, end: 11 }] };
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
        expect(plainText).toBe('-  ');
    });
});

describe('DiffView component export', () => {
    it('exports a callable Solid component', () => {
        expect(typeof DiffView).toBe('function');
    });

    it('renders rows through split spans and per-kind styles', () => {
        expect(source).toContain('const style = kindStyle(line.kind);');
        expect(source).toContain('const spans = splitLineSpans(line);');
        expect(source).toContain('<For each={props.lines}>{(line) => <DiffRow line={line} />}</For>');
    });

    it('replaces mounted visible lines when the supplied diff lines change', async () => {
        // Given: one mounted DiffView reading an initial reactive line collection.
        const [lines, setLines] = createSignal<readonly DiffLine[]>(renderDiff('-obsolete diff line'));
        const setup = await testRender(() => <DiffView lines={lines()} />, { width: 80, height: 4 });

        try {
            await setup.renderOnce();
            const diffView = setup.renderer.root.getChildren().at(0);
            if (diffView === undefined) {
                throw new Error('Expected the mounted diff view');
            }
            expect(setup.captureCharFrame()).toContain('-obsolete diff line');

            // When: the same mounted DiffView receives a replacement collection.
            setLines(renderDiff('+current diff line'));
            await setup.renderOnce();

            // Then: the old line is removed, the new line is visible, and the view itself persists.
            const frame = setup.captureCharFrame();
            expect(setup.renderer.root.getChildren().at(0)).toBe(diffView);
            expect(frame).not.toContain('-obsolete diff line');
            expect(frame).toContain('+current diff line');
        } finally {
            setup.renderer.destroy();
        }
    });
});
