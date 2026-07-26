/**
 * Shared list-windowing helpers for the interactive TUI.
 *
 * Three pure functions extracted byte-for-byte from the previously duplicated
 * `clampSelectedIndex`/`clampSelection`, `getWindowStartIndex`, and
 * `computeWindow` implementations that lived inline in
 * `auth-provider-keypress-view`, `interactive-chat-command-menu`,
 * `interactive-chat-file-autocomplete`, and `models-overlay-state`. The math is
 * delicate (off-by-one on `visibleLimit` edge cases) — do not alter the formulas
 * without re-verifying the merged call sites.
 */

/** A windowed slice plus the clamped active index it was centered on. */
export type WindowSlice = {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly clampedIndex: number;
};

/**
 * Clamp `index` into `[0, count - 1]`. Returns `0` when `count <= 0` so callers
 * never index past an empty list.
 */
export function clampIndex(index: number, count: number): number {
    if (count <= 0) {
        return 0;
    }
    return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Centered-half-window start index. Returns `0` when everything fits
 * (`count <= visibleLimit`), otherwise centers the window on `index` and clamps
 * the start so the window never runs past the list bounds.
 */
export function windowStartIndex(index: number, count: number, visibleLimit: number): number {
    if (count <= visibleLimit) {
        return 0;
    }
    const halfWindow = Math.floor(visibleLimit / 2);
    return Math.min(Math.max(index - halfWindow, 0), count - visibleLimit);
}

/**
 * Compute the visible window and clamped active index for a single column.
 * Mirrors the original `models-overlay-state` implementation exactly: the start
 * index is derived from the already-clamped index, and `endIndex` is inclusive.
 */
export function computeWindow(index: number, count: number, visibleLimit: number): WindowSlice {
    const clampedIndex = clampIndex(index, count);
    const startIndex = windowStartIndex(clampedIndex, count, visibleLimit);
    const visibleCount = Math.min(visibleLimit, count);
    const endIndex = count === 0 ? 0 : startIndex + visibleCount - 1;
    return { startIndex, endIndex, clampedIndex };
}
