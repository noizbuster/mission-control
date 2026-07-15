import { marked, type Token, type Tokens } from 'marked';
import wrapAnsi from 'wrap-ansi';
import { streamBlocks } from '../markdown';
import { terminalDisplayWidth } from '../terminal-text';
import { renderInlineToRuns } from './ir-inline';
import { buildTableBorder, computeTableColumnWidths, reflowRuns } from './ir-layout';
import {
    classifyHeading,
    type InlineRun,
    listItemMarker,
    type RenderBlock,
    type RenderLine,
    textRun,
} from './ir-types';
import type { TerminalMarkdownTheme, TerminalTextStyle } from './theme';

const blankBlock: RenderBlock = { lines: [[]] };

export function renderCodeBlock(
    code: string,
    lang: string | undefined,
    theme: TerminalMarkdownTheme,
    width: number,
): RenderBlock {
    const indent = theme.codeBlockIndent ?? '  ';
    const contentWidth = Math.max(1, width - indent.length);
    const highlighted = theme.highlightCode?.(code, lang);
    const lines: RenderLine[] = [[{ text: `\`\`\`${lang ?? ''}`, style: theme.codeBlockBorder }]];
    for (const [index, rawLine] of code.split('\n').entries()) {
        const line = highlighted?.[index];
        const content = line?.spans.map((span) => ({
            text: span.text,
            style: { ...theme.codeBlock, ...span.style },
        })) ?? [textRun(rawLine, theme.codeBlock)];
        for (const wrapped of reflowRuns(content, contentWidth))
            lines.push([{ text: indent, style: theme.codeBlock }, ...wrapped]);
    }
    lines.push([{ text: '```', style: theme.codeBlockBorder }]);
    return { lines };
}

function flattenCell(cell: Tokens.TableCell, theme: TerminalMarkdownTheme): string {
    return renderInlineToRuns(cell.tokens, theme, {})
        .map((run) => run.text)
        .join('');
}

function isListToken(token: Token): token is Tokens.List {
    return token.type === 'list' && 'items' in token;
}

function isTableToken(token: Token): token is Tokens.Table {
    return token.type === 'table' && 'header' in token && 'rows' in token;
}

function isBlockquoteToken(token: Token): token is Tokens.Blockquote {
    return token.type === 'blockquote' && 'tokens' in token && 'text' in token;
}

function renderTable(token: Tokens.Table, theme: TerminalMarkdownTheme, width: number): RenderBlock {
    const header = token.header.map((cell) => flattenCell(cell, theme));
    const rows = token.rows.map((row) => row.map((cell) => flattenCell(cell, theme)));
    const widths = computeTableColumnWidths(header, rows, width);
    if (widths === null) return { lines: reflowRuns([textRun(token.raw, {})], width) };
    const pad = (text: string, index: number): string =>
        text + ' '.repeat(Math.max(0, (widths[index] ?? 1) - terminalDisplayWidth(text)));
    const wrapCell = (text: string, index: number): readonly string[] =>
        wrapAnsi(text, Math.max(1, widths[index] ?? 1), { hard: true, trim: false }).split('\n');
    const renderRow = (cells: readonly string[], style: TerminalTextStyle): readonly RenderLine[] => {
        const wrapped = cells.map(wrapCell);
        const rowCount = Math.max(...wrapped.map((lines) => lines.length));
        return Array.from({ length: rowCount }, (_, row) => [
            { text: `│ ${wrapped.map((lines, column) => pad(lines[row] ?? '', column)).join(' │ ')} │`, style },
        ]);
    };
    const lines: RenderLine[] = [[{ text: buildTableBorder('top', widths), style: theme.codeBlockBorder }]];
    lines.push(...renderRow(header, theme.bold));
    lines.push([{ text: buildTableBorder('mid', widths), style: theme.codeBlockBorder }]);
    for (const [index, row] of rows.entries()) {
        lines.push(...renderRow(row, {}));
        if (index < rows.length - 1)
            lines.push([{ text: buildTableBorder('mid', widths), style: theme.codeBlockBorder }]);
    }
    lines.push([{ text: buildTableBorder('bot', widths), style: theme.codeBlockBorder }]);
    return { lines };
}

function renderList(token: Tokens.List, theme: TerminalMarkdownTheme, width: number, depth: number): RenderBlock {
    const lines: RenderLine[] = [];
    const start = typeof token.start === 'number' ? token.start : 1;
    for (const [index, item] of token.items.entries()) {
        const marker = listItemMarker({
            ordered: token.ordered,
            start,
            index,
            task: item.task,
            checked: item.checked ?? false,
        });
        const indent = '    '.repeat(depth);
        const prefix = `${indent}${marker}`;
        const continuation = `${indent}${' '.repeat(marker.length)}`;
        let rendered = false;
        for (const itemToken of item.tokens) {
            if (isListToken(itemToken)) {
                lines.push(...renderList(itemToken, theme, width, depth + 1).lines);
                rendered = true;
                continue;
            }
            for (const block of tokenToBlocks([itemToken], theme, Math.max(1, width - prefix.length))) {
                for (const line of block.lines) {
                    lines.push([
                        { text: rendered ? continuation : prefix, style: rendered ? {} : theme.listBullet },
                        ...line,
                    ]);
                    rendered = true;
                }
            }
        }
        if (!rendered) lines.push([{ text: prefix, style: theme.listBullet }]);
    }
    return { lines };
}

function renderBlockquote(token: Tokens.Blockquote, theme: TerminalMarkdownTheme, width: number): RenderBlock {
    const lines: RenderLine[] = [];
    for (const block of tokenToBlocks(token.tokens, theme, Math.max(1, width - 2))) {
        for (const line of block.lines) {
            lines.push([
                { text: '│ ', style: theme.quoteBorder },
                ...line.map((run) => ({
                    text: run.text,
                    style: { ...theme.quote, ...run.style },
                    ...(run.href ? { href: run.href } : {}),
                })),
            ]);
        }
    }
    return { lines };
}

function fallbackText(token: Token): string {
    return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
}

export function tokenToBlocks(
    tokens: readonly Token[],
    theme: TerminalMarkdownTheme,
    width: number,
): readonly RenderBlock[] {
    const blocks: RenderBlock[] = [];
    const base = theme.defaultTextStyle ?? {};
    for (const [index, token] of tokens.entries()) {
        const padAfter = tokens[index + 1]?.type !== undefined && tokens[index + 1]?.type !== 'space';
        switch (token.type) {
            case 'heading': {
                const heading = classifyHeading(token.depth);
                const style = { ...base, ...theme.heading, ...heading.style };
                const runs: InlineRun[] = heading.prefix === '' ? [] : [textRun(heading.prefix, style)];
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, style));
                blocks.push({ lines: reflowRuns(runs, width) });
                if (padAfter) blocks.push(blankBlock);
                break;
            }
            case 'paragraph':
                blocks.push({ lines: reflowRuns(renderInlineToRuns(token.tokens ?? [], theme, base), width) });
                break;
            case 'text':
                blocks.push({
                    lines: reflowRuns(
                        token.tokens?.length
                            ? renderInlineToRuns(token.tokens, theme, base)
                            : [textRun(token.text, base)],
                        width,
                    ),
                });
                break;
            case 'code':
                blocks.push(renderCodeBlock(token.text, token.lang, theme, width));
                if (padAfter) blocks.push(blankBlock);
                break;
            case 'list':
                if (isListToken(token)) blocks.push(renderList(token, theme, width, 0));
                break;
            case 'table':
                if (isTableToken(token)) {
                    blocks.push(renderTable(token, theme, width));
                    if (padAfter) blocks.push(blankBlock);
                }
                break;
            case 'blockquote':
                if (isBlockquoteToken(token)) {
                    blocks.push(renderBlockquote(token, theme, width));
                    if (padAfter) blocks.push(blankBlock);
                }
                break;
            case 'hr':
                blocks.push({ lines: [[{ text: '─'.repeat(Math.min(width, 80)), style: theme.hr }]] });
                if (padAfter) blocks.push(blankBlock);
                break;
            case 'html':
                blocks.push({ lines: reflowRuns([textRun(token.raw.trim(), base)], width) });
                break;
            case 'space':
                blocks.push(blankBlock);
                break;
            default:
                blocks.push({ lines: reflowRuns([textRun(fallbackText(token), base)], width) });
        }
    }
    return blocks;
}

export function buildBlocks(
    text: string,
    width: number,
    streaming: boolean,
    theme: TerminalMarkdownTheme,
): readonly RenderBlock[] {
    if (!streaming) return tokenToBlocks(marked.lexer(text), theme, width);
    return streamBlocks(text, true).flatMap((block) => tokenToBlocks(marked.lexer(block.src), theme, width));
}
