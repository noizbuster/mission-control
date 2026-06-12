import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop redaction projection', () => {
    it('redacts credential families from rendered timeline patch command and approval previews', () => {
        // Given
        const secrets = desktopRenderSecretFixtures();
        const log = sessionLog(secrets);

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
        for (const secret of secretFragments(secrets)) {
            expect(html).not.toContain(secret);
        }
    });
});

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_desktop_redaction',
        fileName: 'session_desktop_redaction.jsonl',
        state: 'available',
        eventCount: 3,
        diagnostics: [{ code: 'corrupt_line', message: 'bad json', lineNumber: 3 }],
    };
}

function sessionLog(secrets: readonly string[]): DesktopSessionLog {
    const payload = desktopRenderSecretPayload(secrets);
    return {
        sessionId: 'session_desktop_redaction',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [{ code: 'corrupt_line', message: `bad json ${payload}`, lineNumber: 3 }],
        envelopes: [
            envelope(0, {
                type: 'task.progress',
                timestamp: '2026-06-09T00:00:00.000Z',
                sessionId: 'session_desktop_redaction',
                message: `timeline ${payload}`,
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
                                lines: secrets
                                    .join('\n')
                                    .split('\n')
                                    .map((content) => ({ kind: 'added' as const, content })),
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
                        argumentsJson: JSON.stringify({ patch: `+${payload}` }),
                    },
                },
            }),
            envelope(1, {
                type: 'command.completed',
                timestamp: '2026-06-09T00:00:01.000Z',
                sessionId: 'session_desktop_redaction',
                message: `command ${payload}`,
                command: {
                    command: ['pnpm', payload],
                    cwd: `/tmp/${payload}`,
                    status: 'completed',
                    exitCode: 0,
                    signal: null,
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    durationMs: 1,
                },
            }),
            envelope(2, {
                type: 'approval.requested',
                timestamp: '2026-06-09T00:00:02.000Z',
                sessionId: 'session_desktop_redaction',
                message: 'approval requested',
                approvalRecord: {
                    approvalId: 'approval_permission_call_patch',
                    requestId: 'permission_call_patch',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'file.patch' },
                    requestedAt: '2026-06-09T00:00:01.000Z',
                    reason: `approve ${payload}`,
                },
            }),
        ],
    };
}

function desktopRenderSecretFixtures(): readonly string[] {
    return [
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyZW5kZXIiOiJtaXNzaW9uLWNvbnRyb2wifQ', 'signaturetest'].join('.'),
        ['ghp', 'testDesktopRenderToken1234567890'].join('_'),
        ['github', 'pat', 'test', 'desktoprender1234567890'].join('_'),
        ['AKIA', 'TESTDESKRENDER12'].join(''),
        ['Bearer', ['bearer', 'testDesktopRenderToken1234567890'].join('_')].join(' '),
        [
            ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
            'desktop-render-secret-body',
            ['-----END', 'PRIVATE KEY-----'].join(' '),
        ].join('\n'),
        ['sk', 'proj', 'testDesktopRenderOpenAI1234567890'].join('-'),
        ['sk', 'ant', 'api03', 'testDesktopRenderAnthropic1234567890'].join('-'),
        ['AIza', 'DesktopRenderGoogleToken1234567890'].join(''),
        ['sk', 'or', 'v1', 'testDesktopRenderCompatible1234567890'].join('-'),
    ];
}

function desktopRenderSecretPayload(secrets: readonly string[]): string {
    return secrets.join('\n');
}

function secretFragments(secrets: readonly string[]): readonly string[] {
    return secrets.flatMap((secret) => secret.split('\n')).filter((fragment) => fragment.length > 0);
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
