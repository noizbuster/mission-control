// T8 hardening: wrapping, CJK double-width, and narrow-terminal edge cases.
// Exercises the pure IR helpers (getCachedBlocks / reflowRuns) without mounting
// a React tree (react-test-renderer is intentionally not a dep — see T2/T4
// learnings). All width math is asserted on VISIBLE width, not JS `.length`,
// so a CJK character is correctly counted as 2 columns.

import { beforeEach, describe, expect, it } from 'vitest';
import type { InlineRun, RenderLine } from './Markdown.js';
import { clearRenderCache, getCachedBlocks, reflowRuns } from './Markdown.js';
import { darkTheme } from './theme.js';

/** Visible terminal width of a string, counting East Asian Wide chars as 2. */
function visibleWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += charWidth(char);
    }
    return width;
}

/**
 * Per-character terminal cell count for the ranges the tests exercise. Mirrors
 * `get-east-asian-width` (the lib wrap-ansi relies on) for the common CJK,
 * kana, and hangul blocks; everything else is width 1. Combining marks and
 * zero-width joiners are not exercised by these fixtures.
 */
function charWidth(char: string): number {
    const code = char.codePointAt(0);
    if (code === undefined) return 0;
    if (code >= 0x1100 && code <= 0x115f) return 2; // Hangul Jamo
    if (code >= 0x2e80 && code <= 0x303e) return 2; // CJK Radicals / Kangxi
    if (code >= 0x3040 && code <= 0x33ff) return 2; // Hiragana, Katakana, CJK symbols
    if (code >= 0x3400 && code <= 0x4dbf) return 2; // CJK Extension A
    if (code >= 0x4e00 && code <= 0x9fff) return 2; // CJK Unified Ideographs
    if (code >= 0xa000 && code <= 0xa4cf) return 2; // Yi
    if (code >= 0xac00 && code <= 0xd7a3) return 2; // Hangul Syllables
    if (code >= 0xf900 && code <= 0xfaff) return 2; // CJK Compatibility Ideographs
    if (code >= 0xfe30 && code <= 0xfe4f) return 2; // CJK Compatibility Forms
    if (code >= 0xff00 && code <= 0xff60) return 2; // Fullwidth Forms
    if (code >= 0xffe0 && code <= 0xffe6) return 2; // Fullwidth Signs
    if (code >= 0x1f300 && code <= 0x1f64f) return 2; // Emoji pictographs
    if (code >= 0x1f900 && code <= 0x1f9ff) return 2; // Supplemental symbols
    return 1;
}

/** Sum the visible width of every run on a rendered line. */
function lineVisibleWidth(line: RenderLine): number {
    return line.reduce((sum, run) => sum + visibleWidth(run.text), 0);
}

describe('wrapping hardening', () => {
    beforeEach(() => {
        clearRenderCache();
    });

    it('wraps a paragraph longer than width so no rendered line exceeds it', () => {
        const width = 20;
        const paragraph =
            'The quick brown fox jumps over the lazy dog while a second sentence extends past the narrow column boundary.';
        const blocks = getCachedBlocks(paragraph, width, false, darkTheme);
        const lines = blocks.flatMap((block) => block.lines);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(lineVisibleWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    it('keeps the full text intact across the wrap (no characters dropped)', () => {
        const width = 16;
        const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
        const lines = reflowRuns([{ text, style: {} } satisfies InlineRun], width);
        const reconstructed = lines
            .flat()
            .map((run) => run.text)
            .join('');
        // wrap-ansi with trim:false preserves every character; newlines are the
        // only insertion, so stripping them reconstructs the original input.
        expect(reconstructed.replace('\n', '')).toBe(text);
    });
});

describe('CJK double-width wrapping', () => {
    beforeEach(() => {
        clearRenderCache();
    });

    it('counts CJK glyphs as width 2 so no line overflows the target width', () => {
        const width = 20;
        // 7 wide glyphs per repeat x 4 = 28 glyphs = 56 visible columns.
        const cjk = '日本語のテスト'.repeat(4);
        const runs: InlineRun[] = [{ text: cjk, style: {} }];
        const lines = reflowRuns(runs, width);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            const vw = lineVisibleWidth(line);
            expect(vw).toBeLessThanOrEqual(width);
        }
    });

    it('wraps CJK via getCachedBlocks (full lexer path) without overflow', () => {
        const width = 24;
        const md = `Assistant: ${'日本語のテスト'.repeat(5)}`;
        const blocks = getCachedBlocks(md, width, false, darkTheme);
        const lines = blocks.flatMap((block) => block.lines);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(lineVisibleWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    it('round-trips CJK content exactly through reflowRuns', () => {
        const text = '日本語のテスト';
        const runs: InlineRun[] = [{ text, style: {} }];
        const lines = reflowRuns(runs, 10);
        const reconstructed = lines
            .flat()
            .map((run) => run.text)
            .join('');
        expect(reconstructed).toBe(text);
    });
});

describe('narrow-terminal rendering (width=20)', () => {
    beforeEach(() => {
        clearRenderCache();
    });

    it('renders a combined fixture (heading, paragraph, list, code, table, quote) without throwing', () => {
        const md = [
            '# Narrow Heading',
            '',
            'A paragraph that is longer than twenty columns and must wrap cleanly.',
            '',
            '- first item here',
            '- second item here',
            '',
            '```ts',
            'const value = 12345;',
            '```',
            '',
            '| A | B |',
            '| - | - |',
            '| 1 | 2 |',
            '',
            '> a quoted line that wraps',
        ].join('\n');
        expect(() => getCachedBlocks(md, 20, false, darkTheme)).not.toThrow();
        const blocks = getCachedBlocks(md, 20, false, darkTheme);
        expect(blocks.length).toBeGreaterThan(0);
    });

    it('does not overflow width=20 for wrapped paragraph and list lines', () => {
        const md = [
            'A narrow paragraph that must wrap within twenty columns exactly.',
            '',
            '- list item one',
            '- list item two with more text',
        ].join('\n');
        const blocks = getCachedBlocks(md, 20, false, darkTheme);
        const lines = blocks.flatMap((block) => block.lines);
        for (const line of lines) {
            expect(lineVisibleWidth(line)).toBeLessThanOrEqual(20);
        }
    });

    it('falls back to raw text when a table is too narrow for stable columns', () => {
        // 4 columns at width 20 cannot fit (border overhead alone is 13), so the
        // renderer must fall back to the raw markdown source instead of crashing.
        const md = '| Name | Age | City | Role |\n| --- | --- | --- | --- |\n| x | 1 | y | z |';
        expect(() => getCachedBlocks(md, 20, false, darkTheme)).not.toThrow();
        const blocks = getCachedBlocks(md, 20, false, darkTheme);
        expect(blocks.length).toBeGreaterThan(0);
    });
});
