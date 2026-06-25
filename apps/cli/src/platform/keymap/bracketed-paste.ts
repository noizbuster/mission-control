/**
 * Bracketed-paste markers + multiline robustness (T13).
 *
 * Ports oh-my-pi's paste-marker logic to the native-textarea bridge. When a
 * paste is "marker-sized" (> 10 lines OR > 1000 chars), the bridge collapses it
 * to a `[Paste #N, +M lines]` (or `[Paste #N, K chars]`) token in the textarea
 * via `insertText`, and stores the full content keyed by id in a
 * `PasteMarkerStore`. On submit, `expand` replaces every marker token with its
 * stored content (the host re-insert hook). Markers with no stored content fall
 * back to the literal token text.
 *
 * The textarea is the source of truth for visible text; `core.inputBuffer` is
 * the mirror, kept in sync by `bridgeContentChange` after the native
 * `onContentChange` fires from `insertText`. The `PasteMarkerStore` is a
 * SEPARATE keyed content store — NOT a parallel text buffer — so this respects
 * the AGENTS.md "no shadow text buffer" anti-pattern.
 *
 * Pure module: no @opentui/core, no React, FFI-free, fully unit-testable.
 * Dynamically imported by the opentui bridge (TUI path) via a static import
 * inside the bridge module that is already behind the dynamic-renderer graph.
 */

// Module-private; a single shared UTF-8 decoder is fine (TextDecoder is stateless
// across decode() calls when stream:false, the default).
const utf8Decoder = new TextDecoder();

/** Lines past which a paste collapses to a marker (oh-my-pi threshold). */
export const PASTE_LINE_THRESHOLD = 10;
/** Characters past which a paste collapses to a marker (oh-my-pi threshold). */
export const PASTE_CHAR_THRESHOLD = 1000;

/** Decode paste bytes (UTF-8). Web-standard TextDecoder (Node + Bun). */
export function decodePasteBytes(bytes: Uint8Array): string {
    return utf8Decoder.decode(bytes);
}

/** Count logical lines in pasted text (0 for empty, else split('\n').length). */
export function countLines(text: string): number {
    return text.length === 0 ? 0 : text.split('\n').length;
}

/** A paste is "marker-sized" when it exceeds the line OR char threshold. */
export function isMarkerSized(text: string): boolean {
    return countLines(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

/**
 * Build the marker token for a stored paste. Mirrors oh-my-pi exactly:
 * `+M lines` when the paste spans more than the line threshold, else `K chars`
 * (the single-huge-line case: > 1000 chars but <= 10 lines).
 */
export function makeMarker(id: number, lineCount: number, charCount: number): string {
    return lineCount > PASTE_LINE_THRESHOLD
        ? `[Paste #${id}, +${lineCount} lines]`
        : `[Paste #${id}, ${charCount} chars]`;
}

/** Pure decision for a paste so the bridge knows whether to collapse it. */
export type PasteDecision =
    | { readonly kind: 'literal' }
    | { readonly kind: 'marker'; readonly lineCount: number; readonly charCount: number };

/**
 * Decide whether a paste should collapse to a marker. Pure (no id/store). The
 * bridge allocates the id, calls `makeMarker`, and stores the content via
 * `PasteMarkerStore.store`. Empty pastes are literal no-ops.
 */
export function evaluatePaste(text: string): PasteDecision {
    if (text.length === 0) {
        return { kind: 'literal' };
    }
    const lineCount = countLines(text);
    if (lineCount > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD) {
        return { kind: 'marker', lineCount, charCount: text.length };
    }
    return { kind: 'literal' };
}

// Matches `[Paste #N]`, `[Paste #N, +M lines]`, and `[Paste #N, K chars]`.
// Module-private so the stateful `g` flag is only ever consumed by
// `String.replace` (which manages lastIndex internally); avoids the
// `.test()`/`.exec()` lastIndex footgun of an exported global regex.
const PASTE_MARKER_PATTERN = /\[Paste #(\d+)(?:, (?:\+\d+ lines|\d+ chars))?\]/g;

/**
 * Keyed content store for collapsed paste markers. NOT a text buffer: it holds
 * the FULL paste content keyed by marker id; the textarea owns the visible
 * marker text. `expand` is the host re-insert hook (called on submit).
 */
export class PasteMarkerStore {
    private readonly entries = new Map<number, string>();

    store(id: number, text: string): void {
        this.entries.set(id, text);
    }

    has(id: number): boolean {
        return this.entries.has(id);
    }

    get(id: number): string | undefined {
        return this.entries.get(id);
    }

    /**
     * Replace every `[Paste #N, ...]` marker in `text` with its stored content.
     * A marker with no stored content falls back to the literal marker text.
     */
    expand(text: string): string {
        return text.replace(PASTE_MARKER_PATTERN, (match, idStr) => {
            const stored = this.entries.get(Number(idStr));
            return stored ?? match;
        });
    }

    /** Drop all stored content (called after a submit drains the textarea). */
    clear(): void {
        this.entries.clear();
    }
}
