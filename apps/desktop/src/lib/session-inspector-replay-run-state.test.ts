import { describe, expect, it } from 'vitest';
import type { DesktopSessionLog } from './agent-client.js';
import { projectReplayInspectorRows } from './session-inspector-replay.js';

describe('desktop replay inspector run state rows', () => {
    it('renders failed and blocked run states as distinct coding rows', () => {
        const rows = projectReplayInspectorRows(sessionLog('session_desktop_replay_run_states'));

        expect(rows.codingSteps).toEqual([
            expect.objectContaining({
                kind: 'run.state',
                subject: 'run | run_failed',
                status: 'failed',
                detail: 'provider exploded | provider exploded | unknown',
            }),
            expect.objectContaining({
                kind: 'run.state',
                subject: 'run | run_blocked',
                status: 'blocked_on_approval',
                detail: 'waiting for approval | waiting for approval | tool_failed | patch_call',
            }),
        ]);
    });
});

function sessionLog(sessionId: string): DesktopSessionLog {
    return {
        sessionId,
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            {
                eventId: 'event_run_failed',
                sequence: 0,
                createdAt: '2026-06-12T00:00:00.000Z',
                sessionId,
                durability: 'durable',
                event: {
                    type: 'run.failed',
                    timestamp: '2026-06-12T00:00:00.000Z',
                    sessionId,
                    message: 'provider exploded',
                    run: {
                        command: 'run',
                        state: 'failed',
                        runId: 'run_failed',
                        reason: 'provider exploded',
                        errorCode: 'unknown',
                    },
                },
            },
            {
                eventId: 'event_run_blocked',
                sequence: 1,
                createdAt: '2026-06-12T00:00:01.000Z',
                sessionId,
                durability: 'durable',
                event: {
                    type: 'run.blocked',
                    timestamp: '2026-06-12T00:00:01.000Z',
                    sessionId,
                    message: 'waiting for approval',
                    run: {
                        command: 'run',
                        state: 'blocked_on_approval',
                        runId: 'run_blocked',
                        reason: 'waiting for approval',
                        errorCode: 'tool_failed',
                        toolCallId: 'patch_call',
                    },
                },
            },
        ],
    };
}
