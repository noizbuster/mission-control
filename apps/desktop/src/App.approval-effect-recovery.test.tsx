import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import type { DesktopApprovalEffectRecord, DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client';

describe('desktop unknown-effect recovery inspector', () => {
    it('renders only unresolved unknown effects apart from approval decision history', () => {
        // Given: an approved decision has a separate, unresolved effect ambiguity.
        const html = renderToStaticMarkup(
            <App
                initialApprovalEffects={[unresolvedUnknownEffect()]}
                initialSessionId="session_effect"
                initialSessionLog={sessionLog()}
                initialSessionSummaries={[summary()]}
            />,
        );

        // When / Then: the operator sees non-executing recovery choices, not another approval decision.
        expect(html).toContain('Effect recovery required');
        expect(html).toContain('The system cannot determine whether this tool effect finished.');
        expect(html).toContain('command.run');
        expect(html).toContain('call_effect');
        expect(html).toContain('Operator outcome: not yet recorded');
        expect(html).toContain('Mark completed');
        expect(html).toContain('Mark failed');
        expect(html).toContain('approval_permission_effect');
        expect(html).toContain('approved');
    });

    it('hides resolved unknown effects so conflicting recovery actions cannot be repeated', () => {
        // Given: the operator already recorded a completed outcome.
        const html = renderToStaticMarkup(
            <App
                initialApprovalEffects={[resolvedUnknownEffect()]}
                initialSessionId="session_effect"
                initialSessionLog={sessionLog()}
                initialSessionSummaries={[summary()]}
            />,
        );

        // When / Then: only the approval history remains; recovery controls are absent.
        expect(html).not.toContain('Effect recovery required');
        expect(html).not.toContain('Mark completed');
        expect(html).not.toContain('Mark failed');
    });
});

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_effect',
        fileName: 'session_effect.jsonl',
        state: 'available',
        eventCount: 1,
        diagnostics: [],
    };
}

function sessionLog(): DesktopSessionLog {
    return {
        sessionId: 'session_effect',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            {
                eventId: 'event_approval',
                sequence: 0,
                createdAt: '2026-07-15T03:00:00.000Z',
                sessionId: 'session_effect',
                durability: 'durable',
                event: {
                    type: 'approval.updated',
                    timestamp: '2026-07-15T03:00:00.000Z',
                    sessionId: 'session_effect',
                    message: 'approval recorded',
                    approvalRecord: {
                        approvalId: 'approval_permission_effect',
                        requestId: 'permission_effect',
                        policyDecision: 'requires_approval',
                        state: 'approved',
                        subject: { kind: 'tool', id: 'command.run' },
                        requestedAt: '2026-07-15T02:59:00.000Z',
                        decidedAt: '2026-07-15T03:00:00.000Z',
                    },
                },
            },
        ],
    };
}

function unresolvedUnknownEffect(): DesktopApprovalEffectRecord {
    return {
        state: 'unknown',
        requestedAt: '2026-07-15T03:00:00.000Z',
        executionToken: 'execution_token',
        leaseExpiresAt: '2026-07-15T03:01:00.000Z',
        executingAt: '2026-07-15T03:00:01.000Z',
        unknownAt: '2026-07-15T03:02:00.000Z',
        effect: {
            sessionId: 'session_effect',
            approvalId: 'approval_permission_effect',
            runId: 'run_effect',
            toolCallId: 'call_effect',
            toolName: 'command.run',
            argumentsJson: '{"command":"node"}',
            workspaceRoot: '/workspace',
        },
    };
}

function resolvedUnknownEffect(): DesktopApprovalEffectRecord {
    return {
        state: 'unknown',
        requestedAt: '2026-07-15T03:00:00.000Z',
        executionToken: 'execution_token',
        leaseExpiresAt: '2026-07-15T03:01:00.000Z',
        executingAt: '2026-07-15T03:00:01.000Z',
        unknownAt: '2026-07-15T03:02:00.000Z',
        outcome: 'completed',
        resolvedAt: '2026-07-15T03:03:00.000Z',
        effect: {
            sessionId: 'session_effect',
            approvalId: 'approval_permission_effect',
            runId: 'run_effect',
            toolCallId: 'call_effect',
            toolName: 'command.run',
            argumentsJson: '{"command":"node"}',
            workspaceRoot: '/workspace',
        },
    };
}
