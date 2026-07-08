import type { FiletypeParserOptions, SimpleHighlight, SyntaxStyle, TextChunk, TreeSitterClient } from '@opentui/core';
import { RGBA } from '@opentui/core';
import { marked } from 'marked';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineRun } from './Markdown.js';
import {
    buildBlocks,
    buildOsc8Hyperlink,
    buildTableBorder,
    classifyHeading,
    computeTableColumnWidths,
    linkFallbackSuffix,
    listItemMarker,
    longestWordWidth,
    Markdown,
    reflowRuns,
    renderCodeBlock,
    renderInlineToRuns,
    stripMailto,
} from './Markdown.js';
import { clearRenderCache, getCachedBlocks } from './render-cache.js';
import { darkTheme } from './theme.js';
import { type HighlighterRuntime, resetHighlighterForTest, setHighlighterRuntime } from './tree-sitter-highlighter.js';

/**
 * Build a fully-mocked HighlighterRuntime returning canned colored TextChunks,
 * so no opentui worker, native core, or network is touched. Mirrors the proven
 * pattern in tree-sitter-highlighter.test.ts; RGBA / rgbToHex stay real so
 * colored-chunk assertions exercise the real decode path.
 */
function createMockHighlighterRuntime(chunks: readonly TextChunk[]): HighlighterRuntime {
    const mockClient = {
        setDataPath: vi.fn((): Promise<void> => Promise.resolve()),
        highlightOnce: vi.fn(
            (): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> =>
                Promise.resolve({ highlights: [] }),
        ),
    } as unknown as TreeSitterClient;
    return {
        getClient: () => mockClient,
        destroyClient: (): Promise<void> => Promise.resolve(),
        buildSyntaxStyle: () => ({ destroy: vi.fn() }) as unknown as SyntaxStyle,
        resolveDataPath: () => '/tmp/mctrl-test-data-dir',
        registerParsers: (_parsers: readonly FiletypeParserOptions[]) => {},
        toTextChunks: () => [...chunks],
        filetypeFromInfoString: (infoString: string) => (infoString === 'ts' ? 'typescript' : undefined),
    };
}

/**
 * Flush pending microtasks until the async fill chain (init -> highlightOnce ->
 * process) settles. Mirrors tree-sitter-highlighter.test.ts.
 */
async function flushPending(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    clearRenderCache();
    resetHighlighterForTest();
    setHighlighterRuntime(
        createMockHighlighterRuntime([{ __isChunk: true, text: 'const x: number = 1;', fg: RGBA.fromHex('#c792ea') }]),
    );
});

afterEach(() => {
    resetHighlighterForTest();
    clearRenderCache();
});

/** Lex a one-paragraph markdown string and return its inline runs. */
function inlineRuns(md: string): readonly InlineRun[] {
    const tokens = marked.lexer(md);
    const first = tokens[0];
    if (first && first.type === 'paragraph') {
        return renderInlineToRuns(first.tokens ?? [], darkTheme, {});
    }
    return [];
}

describe('classifyHeading', () => {
    it('styles h1 as bold + underline with no prefix', () => {
        const result = classifyHeading(1);
        expect(result.style.bold).toBe(true);
        expect(result.style.underline).toBe(true);
        expect(result.prefix).toBe('');
    });

    it('styles h2 as bold without underline and no prefix', () => {
        const result = classifyHeading(2);
        expect(result.style.bold).toBe(true);
        expect(result.style.underline).toBeUndefined();
        expect(result.prefix).toBe('');
    });

    it('shows the `#`-repeat prefix only for depth >= 3', () => {
        expect(classifyHeading(3).prefix).toBe('### ');
        expect(classifyHeading(6).prefix).toBe('###### ');
        expect(classifyHeading(3).style.bold).toBe(true);
    });
});

describe('listItemMarker prefixes', () => {
    it('emits `- ` for an unordered non-task item', () => {
        expect(listItemMarker({ ordered: false, start: 1, index: 0, task: false, checked: false })).toBe('- ');
    });

    it('emits `N. ` for ordered items, numbered from the list start', () => {
        expect(listItemMarker({ ordered: true, start: 1, index: 0, task: false, checked: false })).toBe('1. ');
        expect(listItemMarker({ ordered: true, start: 1, index: 2, task: false, checked: false })).toBe('3. ');
        expect(listItemMarker({ ordered: true, start: 5, index: 0, task: false, checked: false })).toBe('5. ');
    });

    it('emits a task box for task items (checked and unchecked)', () => {
        expect(listItemMarker({ ordered: false, start: 1, index: 0, task: true, checked: true })).toBe('- [x] ');
        expect(listItemMarker({ ordered: false, start: 1, index: 0, task: true, checked: false })).toBe('- [ ] ');
    });
});

describe('computeTableColumnWidths', () => {
    it('returns a width per column that fits the available width', () => {
        const widths = computeTableColumnWidths(
            ['Name', 'Age'],
            [
                ['Alice', '30'],
                ['Bob', '9'],
            ],
            40,
        );
        expect(widths).not.toBeNull();
        if (widths === null) return;
        expect(widths).toHaveLength(2);
        const borderOverhead = 3 * 2 + 1;
        const total = widths.reduce((sum, width) => sum + width, 0) + borderOverhead;
        expect(total).toBeLessThanOrEqual(40);
        // natural widths: Name=5 (Name) vs 5 (Alice); Age=3 vs 2 -> col0=5, col1=3
        expect(widths[0]).toBeGreaterThanOrEqual(5);
        expect(widths[1]).toBeGreaterThanOrEqual(3);
    });

    it('returns null when the available width is too narrow for a stable table', () => {
        expect(computeTableColumnWidths(['A', 'B', 'C', 'D'], [], 5)).toBeNull();
    });

    it('does not throw for a malformed single-cell table at width=20', () => {
        expect(() => computeTableColumnWidths(['A'], [['1']], 20)).not.toThrow();
        const widths = computeTableColumnWidths(['A'], [['1']], 20);
        expect(widths).not.toBeNull();
        expect(widths).toHaveLength(1);
    });
});

describe('buildTableBorder box characters', () => {
    it('emits top border with corners and column joins', () => {
        const border = buildTableBorder('top', [3, 4]);
        expect(border.startsWith('┌─')).toBe(true);
        expect(border).toContain('─┬─');
        expect(border.endsWith('─┐')).toBe(true);
    });

    it('emits a middle separator with column joins', () => {
        const border = buildTableBorder('mid', [3, 4]);
        expect(border.startsWith('├─')).toBe(true);
        expect(border).toContain('─┼─');
        expect(border.endsWith('─┤')).toBe(true);
    });

    it('emits a bottom border with corners', () => {
        const border = buildTableBorder('bot', [3, 4]);
        expect(border.startsWith('└─')).toBe(true);
        expect(border).toContain('─┴─');
        expect(border.endsWith('─┘')).toBe(true);
    });
});

describe('buildOsc8Hyperlink + link helpers', () => {
    it('wraps visible text in an OSC 8 escape terminated correctly', () => {
        const osc = buildOsc8Hyperlink('https://example.com', 'link');
        expect(osc.startsWith('\x1B]8;;https://example.com\x1B\\')).toBe(true);
        expect(osc).toContain('link');
        expect(osc.endsWith('\x1B]8;;\x1B\\')).toBe(true);
    });

    it('stripMailto removes the mailto: scheme', () => {
        expect(stripMailto('mailto:a@b.com')).toBe('a@b.com');
        expect(stripMailto('https://x')).toBe('https://x');
    });

    it('linkFallbackSuffix is empty when text equals the href', () => {
        expect(linkFallbackSuffix('https://x', 'https://x')).toBe('');
        expect(linkFallbackSuffix('mailto:a@b.com', 'a@b.com')).toBe('');
    });

    it('linkFallbackSuffix returns the visible (href) when text differs', () => {
        expect(linkFallbackSuffix('https://x', 'label')).toBe(' (https://x)');
    });
});

describe('renderInlineToRuns', () => {
    it('styles a codespan with the theme code style', () => {
        const runs = inlineRuns('`x`');
        const codespan = runs.find((run) => run.style.bg === '#808080');
        expect(codespan).toBeDefined();
        expect(codespan?.text).toBe('x');
    });

    it('marks a link run with href for OSC 8 rendering', () => {
        const runs = inlineRuns('[label](https://example.com)');
        const linkRun = runs.find((run) => run.href === 'https://example.com');
        expect(linkRun).toBeDefined();
        expect(linkRun?.text).toBe('label');
    });

    it('appends a `(href)` suffix run when link text differs from href', () => {
        const runs = inlineRuns('[label](https://example.com)');
        const last = runs[runs.length - 1];
        expect(last?.text).toBe(' (https://example.com)');
        expect(last?.style.dim).toBe(true);
    });

    it('does not append a suffix when link text equals href', () => {
        const runs = inlineRuns('[https://example.com](https://example.com)');
        const suffix = runs.find((run) => run.text.startsWith(' ('));
        expect(suffix).toBeUndefined();
    });

    it('styles strong runs with bold', () => {
        const runs = inlineRuns('**bold**');
        expect(runs.some((run) => run.style.bold === true && run.text === 'bold')).toBe(true);
    });

    it('renders inline HTML raw (tags preserved, not interpreted)', () => {
        const runs = inlineRuns('<b>x</b>');
        const joined = runs.map((run) => run.text).join('');
        expect(joined).toBe('<b>x</b>');
    });
});

describe('longestWordWidth', () => {
    it('returns the longest whitespace-separated word length', () => {
        expect(longestWordWidth('aa bbbb c')).toBe(4);
    });

    it('caps at the given maximum', () => {
        expect(longestWordWidth('supercalifragilistic', 10)).toBe(10);
    });
});

describe('reflowRuns wrapping', () => {
    it('wraps a long run so no visual line exceeds the width', () => {
        const runs: InlineRun[] = [{ text: 'aaaa bbbb cccc dddd eeee ffff gggg', style: {} }];
        const lines = reflowRuns(runs, 10);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            const len = line.reduce((sum, run) => sum + run.text.length, 0);
            expect(len).toBeLessThanOrEqual(10);
        }
    });

    it('round-trips: concatenating wrapped run texts reconstructs the input', () => {
        const text = 'aaaa bbbb cccc dddd eeee';
        const lines = reflowRuns([{ text, style: {} }], 7);
        const reconstructed = lines
            .flat()
            .map((run) => run.text)
            .join('');
        expect(reconstructed).toBe(text);
    });

    it('splits at a `br` newline run into separate lines', () => {
        const lines = reflowRuns(
            [
                { text: 'first', style: {} },
                { text: '\n', style: {} },
                { text: 'second', style: {} },
            ],
            40,
        );
        expect(lines.length).toBe(2);
        expect(lines[0]?.[0]?.text).toBe('first');
        expect(lines[1]?.[0]?.text).toBe('second');
    });

    it('preserves per-run styles across the wrap boundary', () => {
        const runs: InlineRun[] = [
            { text: 'plain ', style: {} },
            { text: 'boldwordthatwraps', style: { bold: true } },
        ];
        const lines = reflowRuns(runs, 8);
        const boldRuns = lines.flat().filter((run) => run.style.bold);
        expect(boldRuns.map((run) => run.text).join('')).toBe('boldwordthatwraps');
    });
});

describe('getCachedBlocks LRU cache', () => {
    beforeEach(() => {
        clearRenderCache();
    });

    it('returns the same instance for unchanged input', () => {
        const first = getCachedBlocks('# Hi\n\nbody text', 40, false, darkTheme, buildBlocks);
        const second = getCachedBlocks('# Hi\n\nbody text', 40, false, darkTheme, buildBlocks);
        expect(second).toBe(first);
    });

    it('returns a different instance when width changes', () => {
        const at40 = getCachedBlocks('# Hi', 40, false, darkTheme, buildBlocks);
        const at60 = getCachedBlocks('# Hi', 60, false, darkTheme, buildBlocks);
        expect(at60).not.toBe(at40);
    });

    it('rebuilds after the cache is cleared', () => {
        const first = getCachedBlocks('# Hi', 40, false, darkTheme, buildBlocks);
        clearRenderCache();
        const rebuilt = getCachedBlocks('# Hi', 40, false, darkTheme, buildBlocks);
        expect(rebuilt).not.toBe(first);
    });

    it('distinguishes streaming from non-streaming for the same text', () => {
        const live = getCachedBlocks('# Hi', 40, true, darkTheme, buildBlocks);
        const full = getCachedBlocks('# Hi', 40, false, darkTheme, buildBlocks);
        expect(live).not.toBe(full);
    });
});

describe('Markdown component', () => {
    it('is a callable React component', () => {
        expect(typeof Markdown).toBe('function');
    });

    it('renders a heading + paragraph fixture without throwing', () => {
        expect(() =>
            getCachedBlocks('# Title\n\nSome **bold** text.', 40, false, darkTheme, buildBlocks),
        ).not.toThrow();
    });

    it('renders a malformed 1-cell table at width=20 without throwing', () => {
        expect(() => getCachedBlocks('| A |\n| --- |\n| 1 |', 20, false, darkTheme, buildBlocks)).not.toThrow();
    });

    it('renders a combined fixture (heading, paragraph, list, code, table, blockquote, hr) without throwing', async () => {
        const md = [
            '# Heading',
            '',
            'A paragraph with `code` and [a link](https://example.com).',
            '',
            '- item one',
            '- item two',
            '',
            '```ts',
            'const x = 1;',
            '```',
            '',
            '| Col A | Col B |',
            '| ----- | ----- |',
            '| 1 | 2 |',
            '',
            '> a quote',
            '',
            '---',
        ].join('\n');
        expect(() => getCachedBlocks(md, 60, false, darkTheme, buildBlocks)).not.toThrow();
        await flushPending();
    });
});

describe('renderCodeBlock token highlighting', () => {
    it('emits per-token colored runs after the async tree-sitter fill lands', async () => {
        renderCodeBlock('const x: number = 1;', 'ts', darkTheme, 40);
        await flushPending();
        const block = renderCodeBlock('const x: number = 1;', 'ts', darkTheme, 40);
        const bodyRuns = block.lines.slice(1, -1).flat();
        const coloredRuns = bodyRuns.filter((run) => run.style.fg !== undefined && run.style.fg.startsWith('#'));
        expect(coloredRuns.length).toBeGreaterThan(0);
    });
});

describe('streaming-mode block splitting integration', () => {
    it('lexes each stream block independently and produces renderable blocks', async () => {
        expect(() => getCachedBlocks('# Hi\n\n```ts\nconst x', 40, true, darkTheme, buildBlocks)).not.toThrow();
        const blocks = getCachedBlocks('# Hi\n\n```ts\nconst x', 40, true, darkTheme, buildBlocks);
        expect(blocks.length).toBeGreaterThan(0);
        await flushPending();
    });
});
