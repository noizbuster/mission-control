import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop replay inspector parity', () => {
    it('renders provider tool replay sequence, approvals, partial failures, and continuation output', () => {
        const log = sessionLog('session_replay_desktop', [
            providerToolCall('session_replay_desktop'),
            providerMessage('session_replay_desktop', 'turn_initial', 'patch requested'),
            approval('session_replay_desktop', 'approval_pending', 'pending', 'command.run'),
            approval('session_replay_desktop', 'approval_patch', 'approved', 'file.patch'),
            approval('session_replay_desktop', 'approval_command', 'denied', 'command.run'),
            diffApplied('session_replay_desktop'),
            toolFailed('session_replay_desktop'),
            providerMessage('session_replay_desktop', 'turn_initial_continue_1', 'final summary after partial failure'),
        ]);

        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_replay_desktop"
                initialSessionSummaries={[summary('session_replay_desktop', 8, 'available')]}
                initialSessionLog={log}
            />,
        );

        expect(html).toContain('Coding replay');
        expect(html).toContain('provider.tool_call');
        expect(html).toContain('file.patch patch_call');
        expect(html).toContain('continuation');
        expect(html).toContain('final summary after partial failure');
        expect(html).toContain('Tool outcomes');
        expect(html).toContain('partial_failed: applied a.txt; failed b.txt');
        expect(html).toContain('applied: a.txt');
        expect(html).toContain('approval_pending');
        expect(html).toContain('approval_patch');
        expect(html).toContain('approval_command');
        expect(html).toContain('pending');
        expect(html).toContain('approved');
        expect(html).toContain('denied');
    });

    it('renders corrupt log and missing continuation diagnostics without crashing', () => {
        const log = sessionLog(
            'session_replay_corrupt',
            [
                providerToolCall('session_replay_corrupt'),
                toolCompleted('session_replay_corrupt'),
                sessionStopped('session_replay_corrupt'),
            ],
            [{ code: 'corrupt_line', message: 'bad json', lineNumber: 4 }],
        );

        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_replay_corrupt"
                initialSessionSummaries={[summary('session_replay_corrupt', 3, 'corrupt')]}
                initialSessionLog={log}
            />,
        );

        expect(html).toContain('bad json');
        expect(html).toContain('missing_provider_continuation');
        expect(html).toContain('missing provider continuation for file.patch');
        expect(html).toContain('No graph snapshot');
    });
});

type EventInput = DesktopSessionLog['envelopes'][number]['event'];
type DiagnosticInput = DesktopSessionLog['diagnostics'][number];

function summary(sessionId: string, eventCount: number, state: DesktopSessionSummary['state']): DesktopSessionSummary {
    return {
        sessionId,
        fileName: `${sessionId}.jsonl`,
        state,
        eventCount,
        diagnostics: [],
    };
}

function sessionLog(
    sessionId: string,
    events: readonly EventInput[],
    diagnostics: readonly DiagnosticInput[] = [],
): DesktopSessionLog {
    return {
        sessionId,
        state: diagnostics.length > 0 ? 'corrupt' : 'available',
        contents: 'jsonl',
        diagnostics: [...diagnostics],
        envelopes: events.map((event, sequence) => ({
            eventId: `event_${sequence}`,
            sequence,
            createdAt: event.timestamp,
            sessionId,
            durability: 'durable',
            event,
        })),
    };
}

function providerToolCall(sessionId: string): EventInput {
    return {
        type: 'task.progress',
        timestamp: '2026-06-12T00:00:00.000Z',
        sessionId,
        taskId: 'turn_initial',
        message: 'tool call completed: file.patch',
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'provider_request_turn_initial',
            sequence: 1,
            toolCall: {
                toolCallId: 'patch_call',
                toolName: 'file.patch',
                argumentsJson: '{"patch":"diff"}',
            },
        },
    };
}

function providerMessage(sessionId: string, providerTurnId: string, content: string): EventInput {
    return {
        type: 'model.call.completed',
        timestamp: '2026-06-12T00:00:01.000Z',
        sessionId,
        taskId: providerTurnId,
        message: content,
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: `provider_request_${providerTurnId}`,
            sequence: 2,
            message: {
                messageId: `message_${providerTurnId}`,
                role: 'assistant',
                content,
            },
            finishReason: 'stop',
        },
        transcript: {
            providerTurnId,
            messageId: `message_${providerTurnId}`,
            visibility: 'model_visible',
        },
    };
}

function approval(
    sessionId: string,
    approvalId: string,
    state: 'pending' | 'approved' | 'denied',
    toolName: string,
): EventInput {
    return {
        type: state === 'pending' ? 'approval.requested' : 'approval.updated',
        timestamp: '2026-06-12T00:00:02.000Z',
        sessionId,
        message: `approval ${state}`,
        approvalRecord: {
            approvalId,
            requestId: `permission_${approvalId}`,
            policyDecision: 'requires_approval',
            state,
            subject: { kind: 'tool', id: toolName },
            requestedAt: '2026-06-12T00:00:02.000Z',
            ...(state === 'pending' ? {} : { decidedAt: '2026-06-12T00:00:03.000Z' }),
        },
    };
}

function diffApplied(sessionId: string): EventInput {
    return {
        type: 'file.diff.applied',
        timestamp: '2026-06-12T00:00:03.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'patch partially applied',
        diffFiles: [
            {
                filePath: 'a.txt',
                changeKind: 'modified',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: [{ kind: 'added', content: 'ONE' }],
                    },
                ],
            },
        ],
    };
}

function toolFailed(sessionId: string): EventInput {
    return {
        type: 'tool.failed',
        timestamp: '2026-06-12T00:00:04.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'tool failed: file.patch',
        toolResult: {
            toolCallId: 'patch_call',
            status: 'failed',
            error: {
                code: 'tool_failed',
                message: 'partial_failed: applied a.txt; failed b.txt',
                retryable: false,
            },
        },
    };
}

function toolCompleted(sessionId: string): EventInput {
    return {
        type: 'tool.completed',
        timestamp: '2026-06-12T00:00:04.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'tool completed: file.patch',
        toolResult: {
            toolCallId: 'patch_call',
            status: 'completed',
            output: 'applied patch',
        },
    };
}

function sessionStopped(sessionId: string): EventInput {
    return {
        type: 'session.stopped',
        timestamp: '2026-06-12T00:00:05.000Z',
        sessionId,
        message: 'session stopped',
    };
}
