import { terminalDisplayWidth } from '@mission-control/tui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdownAnsi } from './ansi-renderer';
import { RESET } from './ansi-theme';
import { darkTheme, noColorTheme } from './theme';
import { resetHighlighterForTest, setHighlighterRuntime } from './tree-sitter-highlighter';

/**
 * The ANSI renderer flattens the same `tokenToBlocks` IR the interactive
 * opentui renderer builds; to keep code-block assertions deterministic we
 * point the highlighter at a no-op runtime (mirrors Markdown.test.tsx) so
 * `highlightCode` degrades to monochrome instead of touching a real worker.
 */
beforeEach(() => {
    resetHighlighterForTest();
    setHighlighterRuntime({
        getClient: () => {
            throw new Error('no client in ansi-renderer tests');
        },
        destroyClient: (): Promise<void> => Promise.resolve(),
        buildSyntaxStyle: () => {
            throw new Error('no syntax style in ansi-renderer tests');
        },
        resolveDataPath: () => '/tmp/mctrl-ansi-test-data-dir',
        registerParsers: () => {},
        toTextChunks: () => [],
        filetypeFromInfoString: () => undefined,
    });
});

afterEach(() => {
    resetHighlighterForTest();
});

describe('renderMarkdownAnsi - heading truecolor', () => {
    it('opens an h1 with theme.heading truecolor + bold (case a)', () => {
        const out = renderMarkdownAnsi('# Hi', 60, darkTheme, true);
        // darkTheme.heading = { bold: true, fg: '#00ffff' } -> bold(1) then 38;2;0;255;255
        const joined = out.join('\n');
        expect(joined).toContain('\x1b[1m');
        expect(joined).toContain('\x1b[38;2;0;255;255m');
        expect(joined).toContain('Hi');
        expect(joined).toContain(RESET);
    });
});

describe('renderMarkdownAnsi - code block leakage', () => {
    it('has zero \\x1b bytes when colorize=false (case b)', () => {
        const src = ['```ts', 'const x: number = 1;', '```'].join('\n');
        const out = renderMarkdownAnsi(src, 60, darkTheme, false);
        for (const line of out) {
            expect(line).not.toContain('\x1b');
        }
    });

    it('still renders the fence + body text under colorize=false', () => {
        const src = ['```ts', 'const x = 1;', '```'].join('\n');
        const out = renderMarkdownAnsi(src, 60, darkTheme, false);
        const joined = out.join('\n');
        expect(joined).toContain('```ts');
        expect(joined).toContain('const x = 1;');
    });

    it('emits truecolor + border styling when colorize=true', () => {
        const src = ['```ts', 'const x = 1;', '```'].join('\n');
        const out = renderMarkdownAnsi(src, 60, darkTheme, true);
        const joined = out.join('\n');
        // darkTheme.codeBlockBorder = { fg: '#808080', dim: true }
        expect(joined).toContain('\x1b[2m');
        expect(joined).toContain('\x1b[38;2;128;128;128m');
    });
});

describe('renderMarkdownAnsi - colorize=false full doc', () => {
    it('has zero \\x1b bytes across heading/code/list/table/quote/hr (case c)', () => {
        const md = [
            '# Title',
            '',
            'A paragraph with `code` and **bold**.',
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
        const out = renderMarkdownAnsi(md, 60, darkTheme, false);
        for (const line of out) {
            expect(line).not.toContain('\x1b');
        }
    });

    it('renders plain text structure (headings, bullets, borders) under noColorTheme', () => {
        const out = renderMarkdownAnsi('# Hi\n\n- one\n\n---', 40, noColorTheme, false);
        const joined = out.join('\n');
        expect(joined).toContain('Hi');
        expect(joined).toContain('- ');
        expect(joined).toContain('one');
    });
});

describe('renderMarkdownAnsi - CJK wrapping', () => {
    it('wraps a CJK heading without overflowing width 20 (case d)', () => {
        const out = renderMarkdownAnsi('# 中文标题', 20, darkTheme, false);
        expect(out.length).toBeGreaterThan(0);
        for (const line of out) {
            // No escapes under colorize=false; display width counts CJK as 2.
            expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(20);
        }
    });

    it('wraps a long CJK paragraph under a narrow width without overflow', () => {
        const out = renderMarkdownAnsi('中文段落中文段落中文段落中文段落', 10, darkTheme, false);
        for (const line of out) {
            expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(10);
        }
    });
});

describe('renderMarkdownAnsi - table borders', () => {
    it('renders aligned top/mid/bot borders (case e)', () => {
        const src = ['| Col A | Col B |', '| ----- | ----- |', '| 1 | 2 |'].join('\n');
        const out = renderMarkdownAnsi(src, 40, darkTheme, false);
        const joined = out.join('\n');
        expect(joined).toContain('┌─');
        expect(joined).toContain('─┬─');
        expect(joined).toContain('│');
        expect(joined).toContain('─┼─');
        expect(joined).toContain('─┴─');
        expect(joined).toContain('─┘');
    });
});

describe('renderMarkdownAnsi - links', () => {
    it('emits an OSC 8 hyperlink escape under colorize=true', () => {
        const out = renderMarkdownAnsi('[label](https://example.com)', 60, darkTheme, true);
        const joined = out.join('\n');
        expect(joined).toContain('\x1b]8;;https://example.com\x1b\\');
        expect(joined).toContain('label');
    });

    it('falls back to plain text + (href) suffix under colorize=false', () => {
        const out = renderMarkdownAnsi('[label](https://example.com)', 60, darkTheme, false);
        const joined = out.join('\n');
        expect(joined).not.toContain('\x1b]8;;');
        expect(joined).toContain('label');
        expect(joined).toContain('(https://example.com)');
    });
});

describe('renderMarkdownAnsi - robustness', () => {
    it('does not throw on a lone unclosed code fence (adversarial: malformed_input)', () => {
        expect(() => renderMarkdownAnsi('```ts\nconst x = 1;\n', 60, darkTheme, true)).not.toThrow();
        const out = renderMarkdownAnsi('```ts\nconst x = 1;\n', 60, darkTheme, true);
        expect(out.length).toBeGreaterThan(0);
    });

    it('does not throw on empty input', () => {
        expect(() => renderMarkdownAnsi('', 60, darkTheme, true)).not.toThrow();
    });

    it('returns a string[] (not undefined) for a paragraph', () => {
        const out = renderMarkdownAnsi('hello world', 60, darkTheme, true);
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBeGreaterThan(0);
        expect(typeof out[0]).toBe('string');
    });

    it('renders bold/italic/strikethrough/codespan inline marks', () => {
        const out = renderMarkdownAnsi('**b** *i* ~~s~~ `c`', 60, darkTheme, true);
        const joined = out.join('\n');
        expect(joined).toContain('b');
        expect(joined).toContain('i');
        expect(joined).toContain('s');
        expect(joined).toContain('c');
    });
});
