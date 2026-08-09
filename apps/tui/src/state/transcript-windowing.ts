/**
 * Live transcript render windowing.
 *
 * The ChatStore may hold up to MAX_TRANSCRIPT_PARTS (500) for the live view.
 * Mounting every row (markdown/diff/tool cards) still pressures native
 * TextBuffers. This helper keeps a bounded mount window for the Solid Index.
 *
 * Modes:
 * - sticky-bottom (default while streaming / at bottom): newest `limit` rows
 * - bidirectional anchor: center a window around an absolute row index so the
 *   operator can scroll upward through older live rows without mounting all 500
 *
 * Full history remains in the durable session DB. Operators recover rows older
 * than the live store via `/session` reload (same affordance as the clamp notice).
 */

import { expandWindowToHeightBudget, TRANSCRIPT_HEIGHT_OVERSCAN_ROWS } from './transcript-row-metrics';
export const DEFAULT_TRANSCRIPT_RENDER_LIMIT = 80;
export const MIN_TRANSCRIPT_RENDER_LIMIT = 20;
export const MAX_TRANSCRIPT_RENDER_LIMIT = 200;
/** Extra rows kept above/below the estimated viewport when anchoring. */
export const TRANSCRIPT_WINDOW_OVERSCAN = 12;

export type TranscriptWindow<T> = {
    /** Inclusive start index into the full parts array. */
    readonly startIndex: number;
    /** Exclusive end index into the full parts array. */
    readonly endIndex: number;
    /** Sliced rows mounted by the transcript Index. */
    readonly visibleParts: readonly T[];
    /** Number of older rows not mounted (0 when everything fits). */
    readonly hiddenBefore: number;
    /** Number of newer rows not mounted (0 at sticky bottom). */
    readonly hiddenAfter: number;
    /** Total parts in the full live list. */
    readonly totalCount: number;
    /** Absolute index the window was centered on (last row when sticky-bottom). */
    readonly anchorIndex: number;
};

export type TranscriptWindowSpacerHeights = {
    /** Estimated terminal rows represented by hidden parts before the mounted window. */
    readonly beforeRows: number;
    /** Estimated terminal rows represented by hidden parts after the mounted window. */
    readonly afterRows: number;
};

/**
 * Clamp a requested render limit into the supported band.
 * Non-finite / non-positive values fall back to the default.
 */
export function normalizeTranscriptRenderLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
        return DEFAULT_TRANSCRIPT_RENDER_LIMIT;
    }
    const floored = Math.floor(limit);
    if (floored < MIN_TRANSCRIPT_RENDER_LIMIT) return MIN_TRANSCRIPT_RENDER_LIMIT;
    if (floored > MAX_TRANSCRIPT_RENDER_LIMIT) return MAX_TRANSCRIPT_RENDER_LIMIT;
    return floored;
}

function clampIndex(index: number, count: number): number {
    if (count <= 0) return 0;
    if (!Number.isFinite(index)) return count - 1;
    return Math.min(Math.max(Math.floor(index), 0), count - 1);
}

/**
 * Map a scroll position onto an absolute row index for anchoring.
 * Uses a linear ratio of scrollY / maxScrollY over the full list so the
 * operator can walk the entire live store even when only a window is mounted.
 */
export function estimateAnchorIndex(input: {
    readonly totalCount: number;
    readonly scrollY: number;
    readonly viewportHeight: number;
    readonly scrollHeight: number;
}): number {
    const totalCount = input.totalCount;
    if (totalCount <= 0) return 0;
    const maxScrollY = Math.max(0, input.scrollHeight - input.viewportHeight);
    if (maxScrollY <= 0) {
        return totalCount - 1;
    }
    const ratio = Math.min(1, Math.max(0, input.scrollY / maxScrollY));
    return clampIndex(Math.round(ratio * (totalCount - 1)), totalCount);
}

function normalizeTranscriptRowHeight(height: number): number {
    return Number.isFinite(height) && height > 0 ? Math.ceil(height) : 1;
}

/**
 * Resolve the absolute part at a logical vertical offset. Unlike
 * {@link estimateAnchorIndex}, this preserves one-row/page scroll semantics
 * for a virtualized list with mixed-height rows.
 */
export function anchorIndexForTranscriptOffset(input: {
    readonly totalCount: number;
    readonly offsetRows: number;
    readonly heightAt: (index: number) => number;
}): number {
    if (input.totalCount <= 0) return 0;
    let remainingRows = Number.isFinite(input.offsetRows) ? Math.max(0, input.offsetRows) : 0;
    for (let index = 0; index < input.totalCount; index += 1) {
        const height = normalizeTranscriptRowHeight(input.heightAt(index));
        if (remainingRows < height) return index;
        remainingRows -= height;
    }
    return input.totalCount - 1;
}

/**
 * Calculates inert spacer heights for a bounded render window. Together with
 * the mounted rows, these spacers preserve the full transcript's native
 * scroll coordinate system without mounting every expensive row component.
 */
export function transcriptWindowSpacerHeights<T>(input: {
    readonly parts: readonly T[];
    readonly window: Pick<TranscriptWindow<T>, 'startIndex' | 'endIndex'>;
    readonly heightAt: (part: T, index: number) => number;
}): TranscriptWindowSpacerHeights {
    let beforeRows = 0;
    for (let index = 0; index < input.window.startIndex; index += 1) {
        const part = input.parts[index];
        if (part !== undefined) {
            beforeRows += normalizeTranscriptRowHeight(input.heightAt(part, index));
        }
    }
    let afterRows = 0;
    for (let index = input.window.endIndex; index < input.parts.length; index += 1) {
        const part = input.parts[index];
        if (part !== undefined) {
            afterRows += normalizeTranscriptRowHeight(input.heightAt(part, index));
        }
    }
    return { beforeRows, afterRows };
}

/**
 * Derive a render window over `parts`.
 *
 * - When `anchorIndex` is omitted (or at/near the end), keeps the sticky-bottom
 *   newest-`limit` tail so streaming semantics stay correct.
 * - Otherwise centers a bidirectional window on the anchor with overscan-friendly
 *   half-window math, preserving absolute indices for isFirst/isLast.
 */
export function selectTranscriptWindow<T>(
    parts: readonly T[],
    limit: number | undefined = DEFAULT_TRANSCRIPT_RENDER_LIMIT,
    anchorIndex?: number,
): TranscriptWindow<T> {
    const totalCount = parts.length;
    const renderLimit = normalizeTranscriptRenderLimit(limit);
    if (totalCount <= renderLimit) {
        return {
            startIndex: 0,
            endIndex: totalCount,
            visibleParts: parts,
            hiddenBefore: 0,
            hiddenAfter: 0,
            totalCount,
            anchorIndex: totalCount === 0 ? 0 : totalCount - 1,
        };
    }

    const stickyTailStart = totalCount - renderLimit;
    const resolvedAnchor = anchorIndex === undefined ? totalCount - 1 : clampIndex(anchorIndex, totalCount);

    // Near the live tail → sticky-bottom (preserves streaming row identity).
    if (resolvedAnchor >= stickyTailStart) {
        return {
            startIndex: stickyTailStart,
            endIndex: totalCount,
            visibleParts: parts.slice(stickyTailStart),
            hiddenBefore: stickyTailStart,
            hiddenAfter: 0,
            totalCount,
            anchorIndex: resolvedAnchor,
        };
    }

    const half = Math.floor(renderLimit / 2);
    let startIndex = resolvedAnchor - half;
    if (startIndex < 0) startIndex = 0;
    if (startIndex > totalCount - renderLimit) startIndex = totalCount - renderLimit;
    const endIndex = startIndex + renderLimit;
    return {
        startIndex,
        endIndex,
        visibleParts: parts.slice(startIndex, endIndex),
        hiddenBefore: startIndex,
        hiddenAfter: totalCount - endIndex,
        totalCount,
        anchorIndex: resolvedAnchor,
    };
}

/** Dim banner copy when older and/or newer live rows are not mounted. */
export function formatHiddenTranscriptBanner(hiddenBefore: number, hiddenAfter = 0): string | undefined {
    if (!(hiddenBefore > 0) && !(hiddenAfter > 0)) return undefined;
    const parts: string[] = [];
    if (hiddenBefore > 0) {
        const noun = hiddenBefore === 1 ? 'earlier row' : 'earlier rows';
        parts.push(`↑ ${hiddenBefore} ${noun}`);
    }
    if (hiddenAfter > 0) {
        const noun = hiddenAfter === 1 ? 'newer row' : 'newer rows';
        parts.push(`↓ ${hiddenAfter} ${noun}`);
    }
    return `${parts.join(' · ')} hidden from live view (full history in session store; /session to reload)`;
}

/**
 * Height-aware window selection: grows around the anchor until estimated
 * terminal-row budget covers the viewport (+ overscan), still capped by limit.
 */
export function selectTranscriptWindowByHeight<T>(input: {
    readonly parts: readonly T[];
    readonly limit?: number;
    readonly anchorIndex?: number;
    readonly viewportRows: number;
    readonly heightAt: (part: T, index: number) => number;
}): TranscriptWindow<T> {
    const parts = input.parts;
    const totalCount = parts.length;
    const renderLimit = normalizeTranscriptRenderLimit(input.limit);
    if (totalCount <= renderLimit) {
        return {
            startIndex: 0,
            endIndex: totalCount,
            visibleParts: parts,
            hiddenBefore: 0,
            hiddenAfter: 0,
            totalCount,
            anchorIndex: totalCount === 0 ? 0 : totalCount - 1,
        };
    }

    const stickyTailStart = totalCount - renderLimit;
    const resolvedAnchor =
        input.anchorIndex === undefined
            ? totalCount - 1
            : Math.min(Math.max(Math.floor(input.anchorIndex), 0), totalCount - 1);

    if (resolvedAnchor >= stickyTailStart) {
        return {
            startIndex: stickyTailStart,
            endIndex: totalCount,
            visibleParts: parts.slice(stickyTailStart),
            hiddenBefore: stickyTailStart,
            hiddenAfter: 0,
            totalCount,
            anchorIndex: resolvedAnchor,
        };
    }

    const expanded = expandWindowToHeightBudget({
        count: totalCount,
        anchorIndex: resolvedAnchor,
        viewportRows: input.viewportRows,
        maxRows: renderLimit,
        overscanRows: TRANSCRIPT_HEIGHT_OVERSCAN_ROWS,
        heightAt: (index) => input.heightAt(parts[index] as T, index),
    });

    return {
        startIndex: expanded.startIndex,
        endIndex: expanded.endIndex,
        visibleParts: parts.slice(expanded.startIndex, expanded.endIndex),
        hiddenBefore: expanded.startIndex,
        hiddenAfter: totalCount - expanded.endIndex,
        totalCount,
        anchorIndex: resolvedAnchor,
    };
}
