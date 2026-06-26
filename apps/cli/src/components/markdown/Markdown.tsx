/** @jsxImportSource @opentui/react */
// allow: SIZE_OK — full markdown token coverage (19 block+inline variants, table
// width math, LRU cache, wrapping) is mandated by T4 and the file boundary is
// mandated by the task MUST NOT ("only edit Markdown.tsx and Markdown.test.tsx").
// Splitting would create sibling files the task forbids. Pure helpers are kept
// small and individually testable.

/**
 * Ink-native markdown renderer.
 *
 * Walks `marked` tokens and emits Ink `<Box>`/`<Text>` trees styled by the T1
 * theme. Re-expresses pi's token-walking algorithm (temp/ref-repos/pi/.../
 * markdown.ts) as Ink elements instead of ANSI strings: styles live on `<Text>`
 * props, never as embedded `\x1b[` color codes (the OSC 8 hyperlink escape is
 * the one sanctioned exception).
 *
 * Architecture: a serializable intermediate representation (`InlineRun` /
 * `RenderLine` / `RenderBlock`) is produced by pure, individually testable
 * helpers, then a thin React component maps it to Ink elements. A module-level
 * LRU cache stores the IR keyed on `(text, width, streaming, theme)` so a
 * re-render of unchanged input returns the same instance.
 */

import type { Token, Tokens } from 'marked';
import { marked } from 'marked';
import type React from 'react';
import { useSyncExternalStore } from 'react';
import wrapAnsi from 'wrap-ansi';
import { toOpenTuiAttributes, toOpenTuiColor } from '../../platform/opentui-types.js';
// MUST come after ./theme.js: the module graph highlight -> tree-sitter-highlighter
// -> render-cache -> theme -> highlight is circular. Loading render-cache first
// (via the import above) ensures theme.ts body runs AFTER highlight.ts finishes,
// so darkTheme.highlightCode resolves to the real function instead of undefined.
import { getHighlightVersion, subscribeHighlight } from './highlight.js';
import { getCachedBlocks } from './render-cache.js';
import { streamBlocks } from './stream.js';
import type { InkTextStyle, TerminalMarkdownTheme } from './theme.js';
import { darkTheme } from './theme.js';

/**
 * A styled, width-measurable text run. `text` is the VISIBLE content only (no
 * ANSI); `style` is spread onto the `<Text>` that renders it. When `href` is
 * set the renderer wraps `text` in an OSC 8 hyperlink escape at draw time, so
 * `text.length` stays the true visible width for wrapping math.
 */
export type InlineRun = {
    readonly text: string;
    readonly style: InkTextStyle;
    readonly href?: string;
};

/** One visual line = an ordered list of styled runs rendered inline. */
export type RenderLine = readonly InlineRun[];

/** A rendered block = its visual lines, already wrapped to the target width. */
export type RenderBlock = { readonly lines: readonly RenderLine[] };

// ---------------------------------------------------------------------------
// Pure atomic helpers (exported for unit testing).
// ---------------------------------------------------------------------------

/** Build an OSC 8 terminal hyperlink escape wrapping visible `text`. */
export function buildOsc8Hyperlink(href: string, text: string): string {
    return `\x1B]8;;${href}\x1B\\${text}\x1B]8;;\x1B\\`;
}

/** Strip a leading `mailto:` scheme for link text/href equality comparison. */
export function stripMailto(href: string): string {
    return href.startsWith('mailto:') ? href.slice(7) : href;
}

/**
 * Visible `(href)` suffix appended after a link whose text differs from its
 * href. Returns the empty string when the text already equals the href (after
 * stripping `mailto:`), so no redundant URL is shown.
 */
export function linkFallbackSuffix(href: string, text: string): string {
    const comparable = stripMailto(href);
    if (text === href || text === comparable) return '';
    return ` (${href})`;
}

/**
 * Per-depth heading style + prefix. h1 = heading+bold+underline, h2 = heading+
 * bold, h3-h6 = heading+bold with a visible `#`*depth prefix. The prefix is
 * only shown for depth >= 3 so h1/h2 read cleanly.
 */
export function classifyHeading(depth: number): { readonly style: InkTextStyle; readonly prefix: string } {
    const underline = depth === 1;
    const style: InkTextStyle = { bold: true, ...(underline ? { underline: true } : {}) };
    const prefix = depth >= 3 ? `${'#'.repeat(depth)} ` : '';
    return { style, prefix };
}

/** Visible marker prefix for a single list item (bullet + optional task box). */
export function listItemMarker(opts: {
    readonly ordered: boolean;
    readonly start: number;
    readonly index: number;
    readonly task: boolean;
    readonly checked: boolean;
}): string {
    const bullet = opts.ordered ? `${opts.start + opts.index}. ` : '- ';
    return opts.task ? `${bullet}[${opts.checked ? 'x' : ' '}] ` : bullet;
}

/** Longest whitespace-separated word width in `text`, capped at `max`. */
export function longestWordWidth(text: string, max?: number): number {
    let longest = 0;
    for (const word of text.split(/\s+/)) {
        if (word.length > longest) longest = word.length;
    }
    return max === undefined ? longest : Math.min(longest, max);
}

/**
 * Compute per-column widths for a table that must fit inside `availableWidth`.
 * Ports pi's distribution math (markdown.ts:667-756) re-expressed on plain
 * string lengths (no ANSI). Returns `null` when the available width is too
 * narrow to lay out a stable table — callers fall back to the raw source.
 */
export function computeTableColumnWidths(
    headerCells: readonly string[],
    rows: readonly (readonly string[])[],
    availableWidth: number,
): readonly number[] | null {
    const numCols = headerCells.length;
    if (numCols === 0) return null;
    const borderOverhead = 3 * numCols + 1;
    const availableForCells = availableWidth - borderOverhead;
    if (availableForCells < numCols) return null;

    const maxUnbroken = 30;
    const naturalWidths: number[] = new Array<number>(numCols).fill(0);
    const minWordWidths: number[] = new Array<number>(numCols).fill(1);
    const scan = (text: string, col: number): void => {
        if (col >= numCols) return;
        naturalWidths[col] = Math.max(naturalWidths[col] ?? 0, text.length);
        minWordWidths[col] = Math.max(minWordWidths[col] ?? 1, longestWordWidth(text, maxUnbroken));
    };
    for (let col = 0; col < headerCells.length; col++) {
        const cell = headerCells[col];
        if (cell !== undefined) scan(cell, col);
    }
    for (const row of rows) {
        for (let col = 0; col < row.length; col++) {
            const cell = row[col];
            if (cell !== undefined) scan(cell, col);
        }
    }

    let minColumnWidths = minWordWidths.slice();
    let minCellsWidth = minColumnWidths.reduce((sum, width) => sum + width, 0);

    if (minCellsWidth > availableForCells) {
        minColumnWidths = new Array<number>(numCols).fill(1);
        const remaining = availableForCells - numCols;
        if (remaining > 0) {
            const totalWeight = minWordWidths.reduce((sum, width) => sum + Math.max(0, width - 1), 0);
            const growth = minWordWidths.map((width) => {
                const weight = Math.max(0, width - 1);
                return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
            });
            for (let i = 0; i < numCols; i++) {
                minColumnWidths[i] = (minColumnWidths[i] ?? 0) + (growth[i] ?? 0);
            }
            const allocated = growth.reduce((sum, width) => sum + width, 0);
            let leftover = remaining - allocated;
            for (let i = 0; leftover > 0 && i < numCols; i++) {
                minColumnWidths[i] = (minColumnWidths[i] ?? 0) + 1;
                leftover -= 1;
            }
        }
        minCellsWidth = minColumnWidths.reduce((sum, width) => sum + width, 0);
    }

    const totalNaturalWidth = naturalWidths.reduce((sum, width) => sum + width, 0) + borderOverhead;
    let columnWidths: number[];
    if (totalNaturalWidth <= availableWidth) {
        columnWidths = naturalWidths.map((width, idx) => Math.max(width, minColumnWidths[idx] ?? 1));
    } else {
        const totalGrowPotential = naturalWidths.reduce(
            (sum, width, idx) => sum + Math.max(0, width - (minColumnWidths[idx] ?? 1)),
            0,
        );
        const extraWidth = Math.max(0, availableForCells - minCellsWidth);
        columnWidths = minColumnWidths.map((minWidth, idx) => {
            const naturalWidth = naturalWidths[idx] ?? 0;
            const delta = Math.max(0, naturalWidth - minWidth);
            const grow = totalGrowPotential > 0 ? Math.floor((delta / totalGrowPotential) * extraWidth) : 0;
            return minWidth + grow;
        });
        let remaining = availableForCells - columnWidths.reduce((sum, width) => sum + width, 0);
        while (remaining > 0) {
            let grew = false;
            for (let i = 0; i < numCols && remaining > 0; i++) {
                if ((columnWidths[i] ?? 0) < (naturalWidths[i] ?? 0)) {
                    columnWidths[i] = (columnWidths[i] ?? 0) + 1;
                    remaining -= 1;
                    grew = true;
                }
            }
            if (!grew) break;
        }
    }
    return columnWidths;
}

/** Build a box-drawing border row for a table. `kind` selects the join chars. */
export function buildTableBorder(kind: 'top' | 'mid' | 'bot', widths: readonly number[]): string {
    const join = kind === 'top' ? '─┬─' : kind === 'mid' ? '─┼─' : '─┴─';
    const body = widths.map((width) => '─'.repeat(width)).join(join);
    const edges = kind === 'top' ? '┌─' : kind === 'mid' ? '├─' : '└─';
    const edgeClose = kind === 'top' ? '─┐' : kind === 'mid' ? '─┤' : '─┘';
    return `${edges}${body}${edgeClose}`;
}

/**
 * Pack a list of styled runs into visual lines of at most `width` columns.
 * Existing `\n` runs (from `br`) force hard line breaks. Word wrapping between
 * breaks uses `wrap-ansi` with `trim:false` (which preserves every character),
 * so a cumulative-length walk maps wrapped lines back onto the source runs
 * exactly. Round-trip safe: concatenating every output run's text reconstructs
 * the input runs' text.
 */
export function reflowRuns(runs: readonly InlineRun[], width: number): readonly RenderLine[] {
    const effectiveWidth = Math.max(1, width);
    const segments = splitRunsAtNewlines(runs);
    const output: RenderLine[] = [];
    for (const segment of segments) {
        output.push(...wrapSegment(segment, effectiveWidth));
    }
    return output.length === 0 ? [[]] : output;
}

// ---------------------------------------------------------------------------
// Pure inline rendering: tokens -> InlineRun[].
// ---------------------------------------------------------------------------

function textRun(text: string, style: InkTextStyle): InlineRun {
    return { text, style };
}

function flattenRunsText(runs: readonly InlineRun[]): string {
    return runs.map((run) => run.text).join('');
}

/** Safe `.text`/`.raw` accessor for unknown tokens (never throws, no casts). */
function tokenFallbackText(token: Token): string {
    if ('text' in token) {
        const value = token.text;
        if (typeof value === 'string') return value;
    }
    return token.raw;
}

/**
 * Walk inline tokens into a flat list of styled runs. `baseStyle` carries the
 * enclosing block's style (heading / quote / bold-nested) so inline marks layer
 * on top of it instead of resetting. Links carry `href` for OSC 8 rendering and
 * emit a `(href)` suffix run when their visible text differs from the href.
 */
export function renderInlineToRuns(
    tokens: readonly Token[],
    theme: TerminalMarkdownTheme,
    baseStyle: InkTextStyle,
): readonly InlineRun[] {
    const runs: InlineRun[] = [];
    for (const token of tokens) {
        switch (token.type) {
            case 'text': {
                if (token.tokens && token.tokens.length > 0) {
                    runs.push(...renderInlineToRuns(token.tokens, theme, baseStyle));
                } else {
                    runs.push(textRun(token.text, baseStyle));
                }
                break;
            }
            case 'paragraph': {
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, baseStyle));
                break;
            }
            case 'strong': {
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.bold }));
                break;
            }
            case 'em': {
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.italic }));
                break;
            }
            case 'codespan': {
                runs.push(textRun(token.text, { ...baseStyle, ...theme.code }));
                break;
            }
            case 'del': {
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, { ...baseStyle, ...theme.strikethrough }));
                break;
            }
            case 'link': {
                const link = token as Tokens.Link;
                const linkRuns = renderInlineToRuns(link.tokens, theme, { ...baseStyle, ...theme.link }).map((run) => ({
                    text: run.text,
                    style: run.style,
                    href: link.href,
                }));
                runs.push(...linkRuns);
                const suffix = linkFallbackSuffix(link.href, flattenRunsText(linkRuns));
                if (suffix !== '') runs.push(textRun(suffix, { ...baseStyle, ...theme.linkUrl }));
                break;
            }
            case 'br': {
                runs.push(textRun('\n', baseStyle));
                break;
            }
            case 'html': {
                runs.push(textRun(token.raw, baseStyle));
                break;
            }
            default: {
                runs.push(textRun(tokenFallbackText(token), baseStyle));
            }
        }
    }
    return runs;
}

// ---------------------------------------------------------------------------
// Wrapping internals.
// ---------------------------------------------------------------------------

function splitRunsAtNewlines(runs: readonly InlineRun[]): readonly (readonly InlineRun[])[] {
    const segments: InlineRun[][] = [[]];
    for (const run of runs) {
        const parts = run.text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) segments.push([]);
            const part = parts[i];
            if (part && part.length > 0) {
                segments[segments.length - 1] = [
                    ...(segments[segments.length - 1] ?? []),
                    { text: part, style: run.style, ...(run.href ? { href: run.href } : {}) },
                ];
            }
        }
    }
    return segments;
}

function wrapSegment(segment: readonly InlineRun[], width: number): readonly RenderLine[] {
    if (segment.length === 0) return [[]];
    const flat = flattenRunsText(segment);
    const wrapped = wrapAnsi(flat, width, { hard: true, trim: false }).split('\n');
    const lines: RenderLine[] = [];
    let runIdx = 0;
    let runOffset = 0;
    for (const line of wrapped) {
        let remaining = line.length;
        const lineRuns: InlineRun[] = [];
        while (remaining > 0 && runIdx < segment.length) {
            const run = segment[runIdx];
            if (!run) break;
            const available = run.text.length - runOffset;
            const take = Math.min(remaining, available);
            const slice = run.text.slice(runOffset, runOffset + take);
            lineRuns.push({ text: slice, style: run.style, ...(run.href ? { href: run.href } : {}) });
            remaining -= take;
            runOffset += take;
            if (runOffset >= run.text.length) {
                runIdx += 1;
                runOffset = 0;
            }
        }
        lines.push(lineRuns);
    }
    return lines;
}

// ---------------------------------------------------------------------------
// Block renderers.
// ---------------------------------------------------------------------------

const BLANK_BLOCK: RenderBlock = { lines: [[]] };

/**
 * Code block renderer. When `theme.highlightCode` is set, each source line is
 * tokenized into per-span styled runs (the span style layered over the
 * `codeBlock` base), wrapped to the content width, and prefixed with the indent
 * as its own run. When unset, lines render monochrome in `theme.codeBlock`.
 * Header/footer fences use `theme.codeBlockBorder` either way.
 */
export function renderCodeBlock(
    code: string,
    lang: string | undefined,
    theme: TerminalMarkdownTheme,
    width: number,
): RenderBlock {
    const indent = theme.codeBlockIndent ?? '  ';
    const contentWidth = Math.max(1, width - indent.length);
    const codeLines = code.split('\n');
    const highlighted = theme.highlightCode ? theme.highlightCode(code, lang) : undefined;
    const lines: RenderLine[] = [];
    lines.push([{ text: '```' + (lang ?? ''), style: theme.codeBlockBorder }]);
    for (let i = 0; i < codeLines.length; i++) {
        const rawLine = codeLines[i] ?? '';
        if (highlighted) {
            const line = highlighted[i] ?? { spans: [{ text: rawLine, style: {} }] };
            const contentRuns: InlineRun[] = line.spans.map((span) => ({
                text: span.text,
                style: { ...theme.codeBlock, ...span.style },
            }));
            const wrapped = reflowRuns(contentRuns, contentWidth);
            for (const wl of wrapped) {
                lines.push([{ text: indent, style: theme.codeBlock }, ...wl]);
            }
        } else {
            const wrapped = wrapAnsi(rawLine, contentWidth, { hard: true, trim: false }).split('\n');
            for (const wl of wrapped) {
                lines.push([{ text: `${indent}${wl}`, style: theme.codeBlock }]);
            }
        }
    }
    lines.push([{ text: '```', style: theme.codeBlockBorder }]);
    return { lines };
}

function flattenCell(cell: Tokens.TableCell, theme: TerminalMarkdownTheme): string {
    return flattenRunsText(renderInlineToRuns(cell.tokens, theme, {}));
}

function renderTable(token: Tokens.Table, theme: TerminalMarkdownTheme, width: number): RenderBlock {
    const numCols = token.header.length;
    if (numCols === 0) return BLANK_BLOCK;
    const headerTexts = token.header.map((cell) => flattenCell(cell, theme));
    const rowTexts = token.rows.map((row) => row.map((cell) => flattenCell(cell, theme)));
    const colWidths = computeTableColumnWidths(headerTexts, rowTexts, width);
    if (colWidths === null) {
        return { lines: reflowRuns([textRun(token.raw, {})], width) };
    }

    const padCell = (text: string, col: number): string => {
        const target = colWidths[col] ?? 1;
        const padding = Math.max(0, target - text.length);
        return text + ' '.repeat(padding);
    };
    const wrapCell = (text: string, col: number): readonly string[] => {
        const target = Math.max(1, colWidths[col] ?? 1);
        return wrapAnsi(text, target, { hard: true, trim: false }).split('\n');
    };

    const lines: RenderLine[] = [];
    lines.push([{ text: buildTableBorder('top', colWidths), style: theme.codeBlockBorder }]);

    const headerWrapped = headerTexts.map((text, col) => wrapCell(text, col));
    const headerRows = Math.max(...headerWrapped.map((cellLines) => cellLines.length));
    for (let li = 0; li < headerRows; li++) {
        const parts = headerWrapped.map((cellLines, col) => padCell(cellLines[li] ?? '', col));
        lines.push([{ text: `│ ${parts.join(' │ ')} │`, style: theme.bold }]);
    }
    lines.push([{ text: buildTableBorder('mid', colWidths), style: theme.codeBlockBorder }]);

    for (let ri = 0; ri < rowTexts.length; ri++) {
        const row = rowTexts[ri];
        if (!row) continue;
        const rowWrapped = row.map((text, col) => wrapCell(text, col));
        const rowRows = Math.max(...rowWrapped.map((cellLines) => cellLines.length));
        for (let li = 0; li < rowRows; li++) {
            const parts = rowWrapped.map((cellLines, col) => padCell(cellLines[li] ?? '', col));
            lines.push([{ text: `│ ${parts.join(' │ ')} │`, style: {} }]);
        }
        if (ri < rowTexts.length - 1) {
            lines.push([{ text: buildTableBorder('mid', colWidths), style: theme.codeBlockBorder }]);
        }
    }
    lines.push([{ text: buildTableBorder('bot', colWidths), style: theme.codeBlockBorder }]);
    return { lines };
}

function renderList(token: Tokens.List, theme: TerminalMarkdownTheme, width: number, depth: number): RenderBlock {
    const lines: RenderLine[] = [];
    const indent = '    '.repeat(depth);
    const start = typeof token.start === 'number' ? token.start : 1;
    for (let i = 0; i < token.items.length; i++) {
        const item = token.items[i];
        if (!item) continue;
        const marker = listItemMarker({
            ordered: token.ordered,
            start,
            index: i,
            task: item.task,
            checked: item.checked ?? false,
        });
        const firstPrefix = `${indent}${marker}`;
        const continuationPrefix = `${indent}${' '.repeat(marker.length)}`;
        const itemWidth = Math.max(1, width - firstPrefix.length);
        let renderedAny = false;

        for (const itemToken of item.tokens) {
            if (itemToken.type === 'list') {
                const nested = renderList(itemToken as Tokens.List, theme, width, depth + 1);
                for (const line of nested.lines) {
                    lines.push(line);
                }
                renderedAny = true;
                continue;
            }
            const itemBlocks = tokenToBlocks([itemToken], theme, itemWidth);
            for (const block of itemBlocks) {
                for (const line of block.lines) {
                    const prefix = renderedAny ? continuationPrefix : firstPrefix;
                    const prefixStyle = renderedAny ? {} : theme.listBullet;
                    lines.push([{ text: prefix, style: prefixStyle }, ...line]);
                    renderedAny = true;
                }
            }
        }
        if (!renderedAny) {
            lines.push([{ text: firstPrefix, style: theme.listBullet }]);
        }
    }
    return { lines };
}

function renderBlockquote(token: Tokens.Blockquote, theme: TerminalMarkdownTheme, width: number): RenderBlock {
    const contentWidth = Math.max(1, width - 2);
    const childBlocks = tokenToBlocks(token.tokens, theme, contentWidth);
    const quoteStyle = theme.quote;
    const lines: RenderLine[] = [];
    for (const block of childBlocks) {
        for (const line of block.lines) {
            const quoted = line.map((run) => ({
                text: run.text,
                style: { ...quoteStyle, ...run.style },
                ...(run.href ? { href: run.href } : {}),
            }));
            lines.push([{ text: '│ ', style: theme.quoteBorder }, ...quoted]);
        }
    }
    return { lines };
}

/**
 * Walk block tokens into rendered blocks. Each block token handler returns its
 * visual lines, already wrapped to `width`. A trailing blank block follows
 * structural blocks (heading/code/table/blockquote/hr) unless the next token is
 * `space`, mirroring pi's inter-block spacing.
 */
export function tokenToBlocks(
    tokens: readonly Token[],
    theme: TerminalMarkdownTheme,
    width: number,
): readonly RenderBlock[] {
    const blocks: RenderBlock[] = [];
    const base = theme.defaultTextStyle ?? {};
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const nextType = tokens[i + 1]?.type;
        const padAfter = nextType !== undefined && nextType !== 'space';
        switch (token.type) {
            case 'heading': {
                const classified = classifyHeading(token.depth);
                const headingStyle: InkTextStyle = { ...base, ...theme.heading, ...classified.style };
                const runs: InlineRun[] = [];
                if (classified.prefix !== '') runs.push(textRun(classified.prefix, headingStyle));
                runs.push(...renderInlineToRuns(token.tokens ?? [], theme, headingStyle));
                blocks.push({ lines: reflowRuns(runs, width) });
                if (padAfter) blocks.push(BLANK_BLOCK);
                break;
            }
            case 'paragraph': {
                const runs = renderInlineToRuns(token.tokens ?? [], theme, base);
                blocks.push({ lines: reflowRuns(runs, width) });
                break;
            }
            case 'text': {
                const runs =
                    token.tokens && token.tokens.length > 0
                        ? renderInlineToRuns(token.tokens, theme, base)
                        : [textRun(token.text, base)];
                blocks.push({ lines: reflowRuns(runs, width) });
                break;
            }
            case 'code': {
                blocks.push(renderCodeBlock(token.text, token.lang, theme, width));
                if (padAfter) blocks.push(BLANK_BLOCK);
                break;
            }
            case 'list': {
                blocks.push(renderList(token as Tokens.List, theme, width, 0));
                break;
            }
            case 'table': {
                blocks.push(renderTable(token as Tokens.Table, theme, width));
                if (padAfter) blocks.push(BLANK_BLOCK);
                break;
            }
            case 'blockquote': {
                blocks.push(renderBlockquote(token as Tokens.Blockquote, theme, width));
                if (padAfter) blocks.push(BLANK_BLOCK);
                break;
            }
            case 'hr': {
                blocks.push({ lines: [[{ text: '─'.repeat(Math.min(width, 80)), style: theme.hr }]] });
                if (padAfter) blocks.push(BLANK_BLOCK);
                break;
            }
            case 'html': {
                blocks.push({ lines: reflowRuns([textRun(token.raw.trim(), base)], width) });
                break;
            }
            case 'space': {
                blocks.push(BLANK_BLOCK);
                break;
            }
            default: {
                blocks.push({ lines: reflowRuns([textRun(tokenFallbackText(token), base)], width) });
            }
        }
    }
    return blocks;
}

// ---------------------------------------------------------------------------
// Block assembly + module-level LRU cache.
// ---------------------------------------------------------------------------

export function buildBlocks(
    text: string,
    width: number,
    streaming: boolean,
    theme: TerminalMarkdownTheme,
): readonly RenderBlock[] {
    if (streaming) {
        const allBlocks: RenderBlock[] = [];
        for (const block of streamBlocks(text, true)) {
            const tokens = marked.lexer(block.src);
            for (const rendered of tokenToBlocks(tokens, theme, width)) {
                allBlocks.push(rendered);
            }
        }
        return allBlocks;
    }
    const tokens = marked.lexer(text);
    return tokenToBlocks(tokens, theme, width);
}

// ---------------------------------------------------------------------------
// React component.
// ---------------------------------------------------------------------------

export type MarkdownProps = {
    readonly text: string;
    readonly width: number;
    readonly streaming?: boolean;
    readonly theme?: TerminalMarkdownTheme;
    readonly selectable?: boolean;
};

function inkStyleToOpenTuiProps(style: InkTextStyle) {
    const fg = style.color !== undefined ? toOpenTuiColor(style.color) : undefined;
    const bg = style.backgroundColor !== undefined ? toOpenTuiColor(style.backgroundColor) : undefined;
    return {
        ...(fg !== undefined ? { fg } : {}),
        ...(bg !== undefined ? { bg } : {}),
        ...toOpenTuiAttributes(style),
    };
}

function LineView({ line }: { readonly line: RenderLine }): React.ReactNode {
    if (line.length === 0) {
        return <text> </text>;
    }
    return (
        <box flexDirection="row">
            {line.map((run, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: run order is stable for a given line
                <text key={index} {...inkStyleToOpenTuiProps(run.style)}>
                    {run.href ? buildOsc8Hyperlink(run.href, run.text) : run.text}
                </text>
            ))}
        </box>
    );
}

/**
 * Subscribe the calling component to tree-sitter async-fill notifications.
 * Returns the current highlight version; the component re-renders whenever the
 * version bumps (i.e. when an async highlight fill lands and the render LRU is
 * invalidated via `clearRenderCache`). The third `getServerSnapshot` arg keeps
 * React 19 SSR/noop renders happy.
 */
export function useHighlightVersion(): number {
    return useSyncExternalStore(subscribeHighlight, getHighlightVersion, getHighlightVersion);
}

export function Markdown({ text, width, streaming, theme, selectable }: MarkdownProps): React.ReactNode {
    useHighlightVersion();
    const resolvedTheme = theme ?? darkTheme;
    const blocks = getCachedBlocks(text, width, streaming ?? false, resolvedTheme, buildBlocks);
    return (
        <box flexDirection="column" {...(selectable !== undefined ? { selectable } : {})}>
            {blocks.map((block, blockIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: block order is stable for cached input
                <box key={blockIndex} flexDirection="column">
                    {block.lines.map((line, lineIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: line order is stable within a block
                        <LineView key={lineIndex} line={line} />
                    ))}
                </box>
            ))}
        </box>
    );
}
