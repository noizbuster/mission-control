import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop composer and approval inspection', () => {
    it('renders composer controls and approval actions with patch preview and command metadata', () => {
        // Given
        const log = sessionLog([
            {
                type: 'task.progress',
                timestamp: '2026-06-09T00:00:00.000Z',
                sessionId: 'session_write',
                message: 'tool call completed',
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_1',
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'call_patch',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: [
                                'diff --git a/.mission-control-ui.txt b/.mission-control-ui.txt',
                                '--- /dev/null',
                                '+++ b/.mission-control-ui.txt',
                                '@@ -0,0 +1 @@',
                                '+desktop approval preview',
                                '',
                            ].join('\n'),
                        }),
                    },
                },
            },
            {
                type: 'task.progress',
                timestamp: '2026-06-09T00:00:01.000Z',
                sessionId: 'session_write',
                message: 'command call completed',
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_1',
                    sequence: 2,
                    toolCall: {
                        toolCallId: 'call_command',
                        toolName: 'command.run',
                        argumentsJson: JSON.stringify({
                            command: 'pnpm',
                            args: ['test'],
                        }),
                    },
                },
            },
            {
                type: 'approval.requested',
                timestamp: '2026-06-09T00:00:02.000Z',
                sessionId: 'session_write',
                message: 'approval requested',
                approvalRecord: {
                    approvalId: 'approval_permission_call_patch',
                    requestId: 'permission_call_patch',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'file.patch' },
                    requestedAt: '2026-06-09T00:00:02.000Z',
                    reason: 'approve patch',
                },
            },
            {
                type: 'approval.requested',
                timestamp: '2026-06-09T00:00:03.000Z',
                sessionId: 'session_write',
                message: 'approval requested',
                approvalRecord: {
                    approvalId: 'approval_permission_call_command',
                    requestId: 'permission_call_command',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'command.run' },
                    requestedAt: '2026-06-09T00:00:03.000Z',
                    reason: 'approve command',
                },
            },
        ]);

        // When
        const html = renderToStaticMarkup(
            <App initialSessionId="session_write" initialSessionSummaries={[summary()]} initialSessionLog={log} />,
        );

        // Then
        expect(html).toContain('aria-label="chat prompt"');
        expect(html).toContain('Submit prompt');
        expect(html).toContain('Queue follow-up');
        expect(html).toContain('Steer');
        expect(html).toContain('Interrupt');
        expect(html).toContain('Resume');
        expect(html).toContain('Approve');
        expect(html).toContain('Deny');
        expect(html).toContain('desktop approval preview');
        expect(html).toContain('pnpm test');
    });

    it('collapses approval rows to the latest decision state without stale pending actions', () => {
        // Given
        const log = sessionLog([
            {
                type: 'approval.requested',
                timestamp: '2026-06-09T00:00:02.000Z',
                sessionId: 'session_write',
                message: 'approval requested',
                approvalRecord: approvalRecord('pending'),
            },
            {
                type: 'approval.updated',
                timestamp: '2026-06-09T00:00:03.000Z',
                sessionId: 'session_write',
                message: 'approval approved',
                approvalRecord: approvalRecord('approved', '2026-06-09T00:00:03.000Z'),
            },
            {
                type: 'approval.resumed',
                timestamp: '2026-06-09T00:00:04.000Z',
                sessionId: 'session_write',
                message: 'approval resumed',
                approvalRecord: approvalRecord('approved', '2026-06-09T00:00:04.000Z'),
            },
        ]);

        // When
        const html = renderToStaticMarkup(
            <App initialSessionId="session_write" initialSessionSummaries={[summary()]} initialSessionLog={log} />,
        );

        // Then
        expect(html).toContain('approval_permission_call_patch');
        expect(html).toContain('approved');
        expect(html).not.toContain('pending');
        expect(html).not.toContain('Approve');
        expect(html).not.toContain('Deny');
    });
});

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_write',
        fileName: 'session_write.jsonl',
        state: 'available',
        eventCount: 4,
        diagnostics: [],
    };
}

function sessionLog(events: readonly DesktopSessionLog['envelopes'][number]['event'][]): DesktopSessionLog {
    return {
        sessionId: 'session_write',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: events.map((event, sequence) => ({
            eventId: `event_${sequence}`,
            sequence,
            createdAt: event.timestamp,
            sessionId: 'session_write',
            durability: 'durable',
            event,
        })),
    };
}

function approvalRecord(state: 'pending' | 'approved', decidedAt?: string) {
    return {
        approvalId: 'approval_permission_call_patch',
        requestId: 'permission_call_patch',
        policyDecision: 'requires_approval' as const,
        state,
        subject: { kind: 'tool' as const, id: 'file.patch' },
        requestedAt: '2026-06-09T00:00:02.000Z',
        ...(decidedAt !== undefined ? { decidedAt } : {}),
        reason: 'approve patch',
    };
}
