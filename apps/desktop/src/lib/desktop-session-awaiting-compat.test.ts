import { describe, expect, it } from 'vitest';
import { DesktopSessionSnapshotSchema, DesktopSessionSummarySchema } from './desktop-session-schemas';

describe('desktop awaiting session compatibility', () => {
    it('accepts awaiting metadata and legacy records before render', () => {
        const awaiting = {
            reason: 'approval',
            source: {
                approvalId: 'approval_patch',
                runId: 'run_approval',
                toolCallId: 'patch_call',
            },
        };
        const legacySummary = summaryPayload('session_legacy');
        const legacySnapshot = snapshotPayload('session_legacy');
        const awaitingSummary = summaryPayload('session_awaiting', awaiting);
        const awaitingSnapshot = snapshotPayload('session_awaiting', awaiting);

        expect(DesktopSessionSummarySchema.parse(legacySummary)).toEqual(legacySummary);
        expect(DesktopSessionSnapshotSchema.parse(legacySnapshot)).toEqual(legacySnapshot);
        expect(DesktopSessionSummarySchema.parse(awaitingSummary)).toEqual(awaitingSummary);
        expect(DesktopSessionSnapshotSchema.parse(awaitingSnapshot)).toEqual(awaitingSnapshot);
    });

    it('rejects stale awaiting kind metadata before render', () => {
        const staleAwaiting = {
            kind: 'approval',
            source: {
                approvalId: 'approval_patch',
                runId: 'run_approval',
            },
        };

        expect(
            DesktopSessionSummarySchema.safeParse(summaryPayload('session_invalid_kind', staleAwaiting)).success,
        ).toBe(false);
        expect(
            DesktopSessionSnapshotSchema.safeParse(snapshotPayload('session_invalid_kind', staleAwaiting)).success,
        ).toBe(false);
    });
});

function summaryPayload(sessionId: string, awaiting?: unknown) {
    return {
        sessionId,
        fileName: `${sessionId}.jsonl`,
        state: 'available',
        ...(awaiting === undefined ? {} : { status: 'awaiting', awaiting }),
        eventCount: 1,
        diagnostics: [],
    };
}

function snapshotPayload(sessionId: string, awaiting?: unknown) {
    return {
        sessionId,
        state: 'available',
        ...(awaiting === undefined ? {} : { status: 'awaiting', awaiting }),
        eventCount: 1,
        graphIds: [],
        diagnostics: [],
    };
}
