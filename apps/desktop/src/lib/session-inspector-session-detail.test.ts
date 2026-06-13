import { describe, expect, it } from 'vitest';
import type { DesktopSessionLog } from './agent-client.js';
import { projectSessionDetail } from './session-inspector-session-detail.js';

describe('projectSessionDetail', () => {
    it('counts only currently blocked runs after a resumed run completes', () => {
        const projection = projectSessionDetail({
            sessions: [],
            selectedLog: sessionLog('session_blocked_resumed'),
        });

        expect(projection.stats?.blockedRunCount).toBe(0);
    });
});

function sessionLog(sessionId: string): DesktopSessionLog {
    return {
        sessionId,
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            envelope(sessionId, 0, 'event_run_started', {
                type: 'run.started',
                timestamp: '2026-06-13T00:00:00.000Z',
                sessionId,
                message: 'run started',
                run: {
                    command: 'run',
                    state: 'running',
                    runId: 'run_1',
                },
            }),
            envelope(sessionId, 1, 'event_run_blocked', {
                type: 'run.blocked',
                timestamp: '2026-06-13T00:00:01.000Z',
                sessionId,
                message: 'waiting for approval',
                run: {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_1',
                    toolCallId: 'call_patch',
                    reason: 'waiting for approval',
                },
            }),
            envelope(sessionId, 2, 'event_resume_started', {
                type: 'run.started',
                timestamp: '2026-06-13T00:00:02.000Z',
                sessionId,
                message: 'run resumed',
                run: {
                    command: 'resume',
                    state: 'running',
                    runId: 'run_1',
                },
            }),
            envelope(sessionId, 3, 'event_resume_completed', {
                type: 'run.completed',
                timestamp: '2026-06-13T00:00:03.000Z',
                sessionId,
                message: 'run completed',
                run: {
                    command: 'resume',
                    state: 'completed',
                    runId: 'run_1',
                },
            }),
        ],
    };
}

function envelope(
    sessionId: string,
    sequence: number,
    eventId: string,
    event: DesktopSessionLog['envelopes'][number]['event'],
): DesktopSessionLog['envelopes'][number] {
    return {
        eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId,
        durability: 'durable',
        event,
    };
}
