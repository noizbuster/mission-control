/**
 * Pure cursor planning for replay overlay seek operations.
 *
 * Forward seeks apply only the newly exposed envelope range. Backward seeks
 * rebuild from the baseline to avoid retaining projections from later events.
 */
export type ReplayStepInput = {
    readonly cursor: number;
    readonly target: number;
    readonly envelopeCount: number;
};

export type ReplayStepPlan = {
    readonly cursor: number;
    readonly reset: boolean;
    readonly startIndex: number;
};

export function planReplayStep(input: ReplayStepInput): ReplayStepPlan {
    const envelopeCount = Math.max(0, input.envelopeCount);
    const cursor = Math.max(0, Math.min(input.cursor, envelopeCount));
    const target = Math.max(0, Math.min(input.target, envelopeCount));
    const reset = target < cursor;
    return {
        cursor: target,
        reset,
        startIndex: reset ? 0 : cursor,
    };
}
