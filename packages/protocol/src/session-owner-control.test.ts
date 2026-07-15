import { describe, expect, it } from 'vitest';
import {
    SessionOwnerControlAcquireRequestSchema,
    SessionOwnerControlTokenSchema,
    SessionStopReceiptSchema,
} from './session-owner-control';

describe('session owner control protocol', () => {
    it('accepts timeout duration only and rejects transmitted process clocks', () => {
        const request = {
            version: 1,
            id: 'rpc-one',
            method: 'session.acquire',
            params: {
                sessionId: 'session-one',
                requestId: 'request-one',
                operationId: 'operation-one',
                kind: 'exact_session_stop',
                timeoutMs: 1_000,
            },
        };

        expect(SessionOwnerControlAcquireRequestSchema.safeParse(request).success).toBe(true);
        expect(
            SessionOwnerControlAcquireRequestSchema.safeParse({
                ...request,
                params: { ...request.params, barrierKind: 'child_spawn_only' },
            }).success,
        ).toBe(true);
        expect(
            SessionOwnerControlAcquireRequestSchema.safeParse({
                ...request,
                params: { ...request.params, barrierKind: 'all_work' },
            }).success,
        ).toBe(false);
        expect(
            SessionOwnerControlAcquireRequestSchema.safeParse({
                ...request,
                params: { ...request.params, deadlineMonotonicMs: 5_000 },
            }).success,
        ).toBe(false);
        expect(
            SessionOwnerControlAcquireRequestSchema.safeParse({
                ...request,
                params: { ...request.params, deadlineWallMs: 5_000 },
            }).success,
        ).toBe(false);
    });

    it('locks every exact-stop token binding and the cached receipt shape', () => {
        const token = {
            value: 'A'.repeat(43),
            operationId: 'operation-one',
            sessionId: 'session-one',
            kind: 'exact_session_stop',
            ownerId: 'owner-one',
            ownerEpoch: 7,
            timeoutMs: 1_000,
        };
        const receipt = {
            outcome: 'failed',
            requestId: 'request-one',
            operationId: 'operation-one',
            affected: {
                runs: 0,
                approvals: 0,
                sessionAwaits: 0,
                sessionInputs: 0,
                missionRuns: 0,
                asyncJobs: 0,
                toolCalls: 0,
            },
            errorCode: 'stop_timeout',
        };

        expect(SessionOwnerControlTokenSchema.safeParse(token).success).toBe(true);
        expect(SessionOwnerControlTokenSchema.safeParse({ ...token, kind: 'tree_stop' }).success).toBe(false);
        expect(SessionOwnerControlTokenSchema.safeParse({ ...token, ownerEpoch: 8, extra: true }).success).toBe(false);
        expect(SessionStopReceiptSchema.safeParse(receipt).success).toBe(true);
    });
});
