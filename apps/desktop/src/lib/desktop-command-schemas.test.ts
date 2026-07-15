import { describe, expect, it } from 'vitest';
import {
    DesktopApprovalEffectRecordSchema,
    DesktopApprovalEffectResolutionReceiptSchema,
} from './desktop-command-schemas';

describe('desktop approval-effect command schemas', () => {
    it('parses an unknown effect resolution receipt separately from approval decisions', () => {
        // Given: the native bridge reports a durable unknown effect resolved by an operator.
        const payload = unknownEffectReceipt('failed');

        // When: the client parses the response at its native boundary.
        const receipt = DesktopApprovalEffectResolutionReceiptSchema.parse(payload);

        // Then: effect identity and the non-executing outcome remain typed and distinct.
        expect(receipt).toMatchObject({
            sessionId: 'session_effect',
            status: 'resolved',
            effect: {
                state: 'unknown',
                outcome: 'failed',
                effect: { approvalId: 'approval_effect', toolName: 'command.run' },
            },
        });
    });

    it('rejects a malformed unknown effect that only supplies half of a resolution', () => {
        // Given: a bridge payload claims an operator outcome without a durable resolution timestamp.
        const payload = unknownEffectReceipt('completed');
        const effect = payload.effect;
        if (effect === undefined) {
            throw new Error('test fixture omitted the effect');
        }
        const { resolvedAt: _resolvedAt, ...malformed } = effect;

        // When / Then: the native boundary rejects the inconsistent durable state.
        expect(() => DesktopApprovalEffectRecordSchema.parse(malformed)).toThrow();
    });
});

function unknownEffectReceipt(outcome: 'completed' | 'failed') {
    return {
        sessionId: 'session_effect',
        status: 'resolved' as const,
        effect: {
            state: 'unknown' as const,
            requestedAt: '2026-07-15T03:00:00.000Z',
            executionToken: 'execution_token',
            leaseExpiresAt: '2026-07-15T03:01:00.000Z',
            executingAt: '2026-07-15T03:00:01.000Z',
            unknownAt: '2026-07-15T03:02:00.000Z',
            outcome,
            resolvedAt: '2026-07-15T03:03:00.000Z',
            effect: {
                sessionId: 'session_effect',
                approvalId: 'approval_effect',
                runId: 'run_effect',
                toolCallId: 'call_effect',
                toolName: 'command.run',
                argumentsJson: '{"command":"node"}',
                workspaceRoot: '/workspace',
            },
        },
    };
}
