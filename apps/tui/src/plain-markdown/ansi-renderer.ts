import { marked, type Token } from 'marked';
import { terminalTextStyleToAnsi, wrap } from './ansi.js';
import { tokenToBlocks } from './ir-blocks.js';
import { buildOsc8Hyperlink, type InlineRun, type RenderLine } from './ir-types.js';
import type { TerminalMarkdownTheme } from './theme.js';

export function renderMarkdownAnsi(
    source: string,
    width: number,
    theme: TerminalMarkdownTheme,
    colorize: boolean,
): string[] {
    return tokenToBlocks(lexSafely(source), theme, width).flatMap((block) =>
        block.lines.map((line) => flattenLine(line, colorize)),
    );
}

function lexSafely(source: string): readonly Token[] {
    try {
        return marked.lexer(source);
    } catch {
        const fallback = { type: 'text', raw: source, text: source } satisfies Token;
        return [fallback];
    }
}

function flattenLine(line: RenderLine, colorize: boolean): string {
    return line.map((run) => flattenRun(run, colorize)).join('');
}

function flattenRun(run: InlineRun, colorize: boolean): string {
    const visible = run.href !== undefined && colorize ? buildOsc8Hyperlink(run.href, run.text) : run.text;
    return wrap(visible, terminalTextStyleToAnsi(run.style, colorize));
}
