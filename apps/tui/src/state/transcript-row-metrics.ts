/**
 * Estimated row heights for live transcript windowing.
 *
 * OpenTUI does not expose per-child measured heights cheaply on every stream
 * tick, so the window planner uses typed part heuristics (plus a small
 * overscan in rows). Estimates are intentionally conservative (slightly tall)
 * so the mounted window covers the viewport even when markdown wraps denser
 * than expected.
 */

import type { TranscriptPart } from './transcript-part';

export const DEFAULT_ESTIMATED_ROW_HEIGHT = 3;
export const MIN_ESTIMATED_ROW_HEIGHT = 1;
export const MAX_ESTIMATED_ROW_HEIGHT = 40;

/** Extra viewport rows kept above/below the visible band. */
export const TRANSCRIPT_HEIGHT_OVERSCAN_ROWS = 8;

function clampHeight(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_ESTIMATED_ROW_HEIGHT;
    const floored = Math.floor(value);
    if (floored < MIN_ESTIMATED_ROW_HEIGHT) return MIN_ESTIMATED_ROW_HEIGHT;
    if (floored > MAX_ESTIMATED_ROW_HEIGHT) return MAX_ESTIMATED_ROW_HEIGHT;
    return floored;
}

function estimateTextRows(text: string, charsPerRow = 80): number {
    if (text.length === 0) return 1;
    const lines = text.split('\n');
    let rows = 0;
    for (const line of lines) {
        rows += Math.max(1, Math.ceil(Math.max(line.length, 1) / charsPerRow));
    }
    return rows;
}

/**
 * Heuristic height (terminal rows) for a typed transcript part.
 * Unknown / plain status rows stay compact; assistant/markdown/diff expand.
 */
export function estimateTranscriptPartHeight(part: TranscriptPart, viewportColumns = 80): number {
    const cols = viewportColumns > 20 ? viewportColumns : 80;
    switch (part.type) {
        case 'user':
            return clampHeight(estimateTextRows(part.text, cols) + 2);
        case 'assistant':
        case 'reasoning':
            return clampHeight(estimateTextRows(part.text, Math.max(40, cols - 4)) + 1);
        case 'diff':
            return clampHeight(Math.min(24, estimateTextRows(part.text, cols) + 2));
        case 'code':
        case 'command':
            return clampHeight(Math.min(20, estimateTextRows(part.text, cols) + 2));
        case 'block-tool':
            return clampHeight(Math.min(20, estimateTextRows(part.output ?? part.text, cols) + 2));
        case 'inline-tool':
        case 'status':
        case 'event':
            return clampHeight(1);
        case 'subagent':
            return clampHeight(estimateTextRows(part.text, cols) + 1);
        case 'error':
            return clampHeight(estimateTextRows(part.text, cols) + 2);
        case 'legacy':
            return clampHeight(estimateTextRows(part.text, cols));
        default:
            return DEFAULT_ESTIMATED_ROW_HEIGHT;
    }
}

/** Legacy ChatBlock height: count lines with a small role chrome pad. */
export function estimateLegacyBlockHeight(block: { readonly lines: readonly string[] }, viewportColumns = 80): number {
    const cols = viewportColumns > 20 ? viewportColumns : 80;
    let rows = 0;
    for (const line of block.lines) {
        rows += Math.max(1, Math.ceil(Math.max(line.length, 1) / cols));
    }
    return clampHeight(rows + 1);
}

/**
 * Grow a bidirectional index window until the estimated height covers the
 * viewport (+ overscan), capped by maxRows.
 */
export function expandWindowToHeightBudget(input: {
    readonly count: number;
    readonly anchorIndex: number;
    readonly viewportRows: number;
    readonly maxRows: number;
    readonly heightAt: (index: number) => number;
    readonly overscanRows?: number;
}): { readonly startIndex: number; readonly endIndex: number } {
    const count = input.count;
    if (count <= 0) return { startIndex: 0, endIndex: 0 };
    const maxRows = Math.max(1, input.maxRows);
    if (count <= maxRows) return { startIndex: 0, endIndex: count };

    const overscan = input.overscanRows ?? TRANSCRIPT_HEIGHT_OVERSCAN_ROWS;
    const budget = Math.max(1, input.viewportRows) + overscan * 2;
    let start = Math.min(Math.max(input.anchorIndex, 0), count - 1);
    let end = start + 1;
    let height = input.heightAt(start);

    // Prefer keeping the anchor and growing outward (down first for sticky feel,
    // then up) until the budget or maxRows is hit.
    let guard = 0;
    while (height < budget && end - start < maxRows && (start > 0 || end < count) && guard < count + 2) {
        guard += 1;
        const canUp = start > 0;
        const canDown = end < count;
        if (canDown && (!canUp || height < budget / 2 || end - 1 <= input.anchorIndex)) {
            height += input.heightAt(end);
            end += 1;
            continue;
        }
        if (canUp) {
            start -= 1;
            height += input.heightAt(start);
            continue;
        }
        if (canDown) {
            height += input.heightAt(end);
            end += 1;
        }
    }

    // If still under maxRows near list edges, fill remaining slots.
    while (end - start < maxRows && start > 0) {
        start -= 1;
    }
    while (end - start < maxRows && end < count) {
        end += 1;
    }

    return { startIndex: start, endIndex: end };
}
