import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog, DesktopSessionSummary } from './lib/agent-client.js';

describe('Desktop coding-agent inspector surfaces', () => {
    it('renders trust status, blocked resumable run state, session tree metadata, and event stats', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_coding_agent"
                initialSessionSummaries={[summary()]}
                initialSessionLog={sessionLog()}
            />,
        );

        expect(html).toContain('Trust status');
        expect(html).toContain('trusted');
        expect(html).toContain('/workspace/mission-control');
        expect(html).toContain('Session tree');
        expect(html).toContain('session_parent');
        expect(html).toContain('entry_active');
        expect(html).toContain('blocked_on_approval');
        expect(html).toContain('waiting for approval: file.patch');
        expect(html).toContain('Session stats');
        expect(html).toContain('pending approvals');
        expect(html).toContain('command events');
        expect(html).toContain('diff events');
        expect(html).toContain('approval_permission_call_patch');
        expect(html).toContain('src/agent.ts');
        expect(html).toContain('pnpm test');
    });
});

function summary(): DesktopSessionSummary {
    return {
        sessionId: 'session_coding_agent',
        fileName: 'session_coding_agent.jsonl',
        state: 'available',
        eventCount: 8,
        diagnostics: [],
    };
}

function sessionLog(): DesktopSessionLog {
    const sessionId = 'session_coding_agent';
    const timestamp = '2026-06-13T00:00:00.000Z';
    const events: readonly DesktopSessionLog['envelopes'][number]['event'][] = [
        {
            type: 'session.metadata.updated',
            timestamp,
            sessionId,
            message: 'session metadata updated',
            sessionTree: {
                kind: 'metadata',
                name: 'Coding parity session',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                workspaceTrust: 'trusted',
                parentSessionId: 'session_parent',
            },
        },
        {
            type: 'session.tree.entry',
            timestamp: '2026-06-13T00:00:01.000Z',
            sessionId,
            message: 'tree entry active',
            sessionTree: {
                kind: 'entry',
                entryId: 'entry_root',
                active: false,
            },
        },
        {
            type: 'session.tree.entry',
            timestamp: '2026-06-13T00:00:02.000Z',
            sessionId,
            message: 'tree entry active',
            sessionTree: {
                kind: 'entry',
                entryId: 'entry_active',
                parentEntryId: 'entry_root',
                active: true,
            },
        },
        {
            type: 'run.blocked',
            timestamp: '2026-06-13T00:00:03.000Z',
            sessionId,
            message: 'waiting for approval: file.patch',
            run: {
                command: 'run',
                state: 'blocked_on_approval',
                runId: 'run_blocked',
                toolCallId: 'call_patch',
                reason: 'waiting for approval: file.patch',
            },
        },
        {
            type: 'approval.requested',
            timestamp: '2026-06-13T00:00:04.000Z',
            sessionId,
            message: 'approval requested',
            approvalRecord: {
                approvalId: 'approval_permission_call_patch',
                requestId: 'permission_call_patch',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'file.patch' },
                requestedAt: '2026-06-13T00:00:04.000Z',
            },
        },
        {
            type: 'file.diff.proposed',
            timestamp: '2026-06-13T00:00:05.000Z',
            sessionId,
            message: 'diff proposed',
            diffFiles: [
                {
                    filePath: 'src/agent.ts',
                    changeKind: 'modified',
                    hunks: [
                        {
                            oldStart: 1,
                            oldLines: 1,
                            newStart: 1,
                            newLines: 1,
                            lines: [{ kind: 'added', content: 'updated content' }],
                        },
                    ],
                },
            ],
        },
        {
            type: 'command.completed',
            timestamp: '2026-06-13T00:00:06.000Z',
            sessionId,
            message: 'command completed',
            command: {
                command: ['pnpm', 'test'],
                cwd: '/workspace/mission-control',
                status: 'completed',
                exitCode: 0,
            },
        },
    ];

    return {
        sessionId,
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
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
