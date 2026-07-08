/**
 * Tokenizing syntax highlighter for code blocks.
 *
 * This module is a thin re-export shim over the tree-sitter-backed highlighter
 * in {@link ./tree-sitter-highlighter.js}. It owns the {@link HighlightedSpan}
 * / {@link HighlightedLine} type definitions (consumed by `theme.ts`,
 * `text-attributes.ts`, and the tree-sitter highlighter itself via type-only
 * imports) and re-exports the sync entry point as `highlightCode`.
 *
 * The tree-sitter backend bridges opentui's async tree-sitter engine to the
 * sync `highlightCode(code, lang) => HighlightedLine[]` contract via a
 * cache-miss-then-async-fill pattern: the first call for a (code, lang) pair
 * returns monochrome immediately and fires an async parse; once it resolves the
 * colored lines are cached, the markdown render LRU is invalidated, and the
 * version emitter notifies React (via `subscribeHighlight` /
 * `getHighlightVersion`) so the block re-renders and hits the cache.
 * Unsupported or unknown languages return monochrome with no schedule.
 * Highlighting never throws into the renderer: every failure path degrades to
 * monochrome and logs a diagnostic to stderr. See
 * `./tree-sitter-highlighter.ts` for the full orchestration.
 */

import type { TerminalTextStyle } from './theme.js';

/** One styled text fragment produced by the highlighter. */
export type HighlightedSpan = { readonly text: string; readonly style: TerminalTextStyle };

/** One source line's worth of styled spans. */
export type HighlightedLine = { readonly spans: ReadonlyArray<HighlightedSpan> };

export {
    closeTreeSitterClient,
    getHighlightVersion,
    highlightTreeSitter as highlightCode,
    monochrome,
    subscribeHighlight,
} from './tree-sitter-highlighter.js';
