import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop redaction projection', () => {
    it('redacts token-like material from timeline patch and approval previews', () => {
        // Given
        const secret = ['sk', 'desktop_redaction_123'].join('-');
        const log = sessionLog(secret);

        // When
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_desktop_redaction"
                initialSessionSummaries={[summary()]}
                initialSessionLog={log}
            />,
        );

        // Then
        expect(html).toContain('[REDACTED_CREDENTIAL]');
        expect(html).not.toContain(secret);
    });
});

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_desktop_redaction',
        fileName: 'session_desktop_redaction.jsonl',
        state: 'available',
        eventCount: 2,
        diagnostics: [],
    };
}

function sessionLog(secret: string): DesktopSessionLog {
    return {
        sessionId: 'session_desktop_redaction',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            envelope(0, {
                type: 'task.progress',
                timestamp: '2026-06-09T00:00:00.000Z',
                sessionId: 'session_desktop_redaction',
                message: `timeline ${secret}`,
                diffFiles: [
                    {
                        filePath: 'notes.txt',
                        changeKind: 'modified',
                        hunks: [
                            {
                                oldStart: 1,
                                oldLines: 1,
                                newStart: 1,
                                newLines: 1,
                                lines: [{ kind: 'added', content: secret }],
                            },
                        ],
                    },
                ],
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_desktop_redaction',
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'call_patch',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({ patch: `+${secret}` }),
                    },
                },
            }),
            envelope(1, {
                type: 'approval.requested',
                timestamp: '2026-06-09T00:00:01.000Z',
                sessionId: 'session_desktop_redaction',
                message: 'approval requested',
                approvalRecord: {
                    approvalId: 'approval_permission_call_patch',
                    requestId: 'permission_call_patch',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'file.patch' },
                    requestedAt: '2026-06-09T00:00:01.000Z',
                    reason: `approve ${secret}`,
                },
            }),
        ],
    };
}

type EventInput = DesktopSessionLog['envelopes'][number]['event'];

function envelope(sequence: number, event: EventInput): DesktopSessionLog['envelopes'][number] {
    return {
        eventId: `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: 'session_desktop_redaction',
        durability: 'durable',
        event,
    };
}
