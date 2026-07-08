/**
 * Pure-string Markdown -> ANSI renderer (no React, no opentui).
 *
 * Reuses the interactive renderer's `tokenToBlocks` IR (`Markdown.tsx`): the
 * same `marked.lexer` token walk, the same `renderInlineToRuns` inline walker,
 * the same CJK-safe `wrap-ansi` wrapping, and the same `computeTableColumnWidths`
 * table math already run inside the IR. This module only re-expresses the IR's
 * `InlineRun`/`RenderLine`/`RenderBlock` shapes as ANSI-styled strings by
 * flattening each run's `TerminalTextStyle` through T2's
 * `terminalTextStyleToAnsi(style, colorize)` bridge and wrapping the visible
 * text with `wrap(text, open)`.
 *
 * Link runs carry `href` on the IR; under `colorize=true` each link run is
 * wrapped in an OSC 8 hyperlink escape (mirrors `buildOsc8Hyperlink`), and under
 * `colorize=false` links render as plain text (the `(href)` suffix is already a
 * separate IR run produced by `renderInlineToRuns`). Code-block spans are
 * already flattened into `InlineRun`s by `renderCodeBlock` (each span's style
 * layered over `theme.codeBlock`), so per-run ANSI conversion is the highlighted
 * output. `colorize=false` produces zero `\x1b` bytes because the bridge returns
 * `''` and `wrap` is a no-op on an empty open.
 *
 * Composition with streaming: `renderMarkdownAnsi` is non-streaming by design
 * (the signature has no streaming flag). A caller that needs live-stream healing
 * splits the buffer via `streamBlocks(src, true)` (`stream.ts`) and calls
 * `renderMarkdownAnsi` on each healed block's `src`.
 */

import type { Token } from 'marked';
import { marked } from 'marked';
import { terminalTextStyleToAnsi, wrap } from './ansi-theme.js';
import type { InlineRun, RenderLine } from './Markdown.js';
import { buildOsc8Hyperlink, tokenToBlocks } from './Markdown.js';
import type { TerminalMarkdownTheme } from './theme.js';

/**
 * Render a markdown source string into ANSI-styled terminal lines.
 *
 * Each returned string is one visual line already wrapped to `width` display
 * columns (CJK glyphs count as 2). When `colorize === false` the output is pure
 * text with zero `\x1b` escape bytes. Never throws: malformed markdown lexes
 * best-effort, and a lexer failure falls back to the raw source split on `\n`.
 */
export function renderMarkdownAnsi(
    src: string,
    width: number,
    theme: TerminalMarkdownTheme,
    colorize: boolean,
): string[] {
    const tokens = lexSafely(src);
    const blocks = tokenToBlocks(tokens, theme, width);
    const lines: string[] = [];
    for (const block of blocks) {
        for (const line of block.lines) {
            lines.push(flattenLine(line, colorize));
        }
    }
    return lines;
}

/** Lex markdown, falling back to a single raw-text token on any lexer failure. */
function lexSafely(src: string): readonly Token[] {
    try {
        return marked.lexer(src);
    } catch {
        return [{ type: 'text', raw: src, text: src } as Token];
    }
}

/** Flatten one visual line of styled runs into a single ANSI string. */
function flattenLine(line: RenderLine, colorize: boolean): string {
    if (line.length === 0) return '';
    let out = '';
    for (const run of line) {
        out += flattenRun(run, colorize);
    }
    return out;
}

/** Convert one styled run to an ANSI-styled string (OSC 8 hyperlinks when colorized). */
function flattenRun(run: InlineRun, colorize: boolean): string {
    const open = terminalTextStyleToAnsi(run.style, colorize);
    const visible = run.href !== undefined && colorize ? buildOsc8Hyperlink(run.href, run.text) : run.text;
    return wrap(visible, open);
}
