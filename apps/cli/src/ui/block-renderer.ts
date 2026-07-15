/**
 * OutputBlock -> ANSI block renderer.
 *
 * Mirrors opencode's `block()` / `inline()` model (run.ts:69-102): each
 * OutputBlock kind maps to either a compact one-liner ("inline") or a
 * blank-separated header+body "block". `renderBlock` returns the rendered
 * string for one block; `joinBlocks` concatenates a rendered sequence while
 * collapsing runs of blank lines (mirrors opencode `UI.empty` dedup).
 *
 * `colorize` is derived as `opts.tty && opts.theme !== noColorTheme`. When
 * false, T2's `terminalTextStyleToAnsi` returns `''` so no `\x1b` escapes are
 * emitted, but the block STRUCTURE (leading/trailing blank lines, headers,
 * gear icons) is preserved for non-TTY consumers (piped output, logs).
 *
 * The theme type is the repo's existing `TerminalMarkdownTheme`
 * (`apps/tui/src/components/markdown/theme.ts`); no new theme type is
 * introduced.
 */

import { renderMarkdownAnsi } from '@mission-control/tui/ansi-renderer';
import { TEXT_DANGER_BOLD, terminalTextStyleToAnsi, wrap } from '@mission-control/tui/ansi-theme';
import type { TerminalMarkdownTheme } from '@mission-control/tui/markdown-theme';
import { mergeTextStyle, noColorTheme } from '@mission-control/tui/markdown-theme';
import type { OutputBlock } from './output-blocks';

export type RenderBlockOptions = {
    readonly width: number;
    readonly tty: boolean;
    readonly thinking: boolean;
    readonly theme: TerminalMarkdownTheme;
};

/** Read-class tool names render as a compact one-liner (opencode "inline"). */
const READ_CLASS_TOOLS = new Set<string>([
    'read',
    'ls',
    'grep',
    'find',
    'glob',
    'repo.read',
    'repo.list',
    'repo.search',
    'todowrite',
]);

const MAX_ARG_SUMMARY = 60;

/**
 * Render a single OutputBlock into an ANSI string. Returns `''` for a
 * suppressed reasoning block (when `opts.thinking === false`). The caller
 * joins multiple results via `joinBlocks`.
 */
export function renderBlock(block: OutputBlock, opts: RenderBlockOptions): string {
    const colorize = opts.tty && opts.theme !== noColorTheme;
    switch (block.kind) {
        case 'session-header': {
            const variant = block.variantID !== undefined ? `#${block.variantID}` : '';
            return `\n> ${block.providerID} \u00b7 ${block.modelID}${variant}\n`;
        }
        case 'assistant-text': {
            const lines = renderMarkdownAnsi(block.text, opts.width, opts.theme, colorize);
            return `\n${lines.join('\n')}\n`;
        }
        case 'reasoning': {
            if (!opts.thinking) return '';
            const style = mergeTextStyle(opts.theme.quote, opts.theme.italic);
            const open = terminalTextStyleToAnsi(style, colorize);
            const rendered = block.text
                .split('\n')
                .map((line) => wrap(line, open))
                .join('\n');
            return `\n${rendered}\n`;
        }
        case 'tool': {
            if (READ_CLASS_TOOLS.has(block.toolName)) {
                const summary = summarizeArgs(block.argumentsJson);
                const tail = summary !== '' ? ` ${summary}` : '';
                return `\n\u2699 ${block.toolName}${tail}\n`;
            }
            const header = `\n\u2699 ${block.toolName}\n`;
            const body = block.error !== undefined ? block.error.message : (block.output ?? '');
            if (body.trim() === '') return header;
            return `${header}${body}\n`;
        }
        case 'error': {
            const open = colorize ? TEXT_DANGER_BOLD : '';
            return `\n${wrap('Error:', open)} ${block.message}\n`;
        }
    }
}

/**
 * Join rendered block strings, collapsing runs of 3+ consecutive newlines
 * into at most one blank line (`\n\n`). Mirrors opencode `UI.empty()` which
 * suppresses consecutive blank lines. Empty block strings (e.g. suppressed
 * reasoning) are dropped before joining.
 */
export function joinBlocks(blocks: readonly string[]): string {
    return blocks
        .filter((b) => b !== '')
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * Extract a short argument summary from a tool's argumentsJson. Picks the
 * first JSON string VALUE (the key is skipped via the `:\s*"` prefix) so a
 * read tool shows its path, not `{"path":...}`. Falls back to the raw json
 * on no match. Truncated to MAX_ARG_SUMMARY chars.
 */
function summarizeArgs(json: string): string {
    if (json === '') return '';
    const match = /:\s*"([^"]*)"/.exec(json);
    const raw = match?.[1] ?? json;
    if (raw.length <= MAX_ARG_SUMMARY) return raw;
    return `${raw.slice(0, MAX_ARG_SUMMARY - 3)}...`;
}
