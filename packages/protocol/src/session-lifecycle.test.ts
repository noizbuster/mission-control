import { describe, expect, it } from 'vitest';
import {
    AgentSessionSchema,
    AgentSnapshotSchema,
    SessionAwaitingDetailsSchema,
    SessionAwaitingReasonSchema,
    SessionAwaitingSourceSchema,
    SessionStatusSchema,
} from './schema';

describe('session lifecycle protocol schemas', () => {
    it('parses awaiting as a public session lifecycle status', () => {
        expect(SessionStatusSchema.parse('awaiting')).toBe('awaiting');
        expect(SessionAwaitingReasonSchema.parse('approval')).toBe('approval');

        const session = AgentSessionSchema.parse({
            id: 'session_awaiting',
            status: 'awaiting',
            startedAt: '2026-06-02T10:00:00.000Z',
            awaiting: {
                reason: 'approval',
                source: {
                    approvalId: 'approval_1',
                    runId: 'run_1',
                    toolCallId: 'tool_call_1',
                },
            },
        });

        const snapshot = AgentSnapshotSchema.parse({
            sessionId: 'session_awaiting',
            status: 'awaiting',
            startedAt: '2026-06-02T10:00:00.000Z',
            runningTaskCount: 0,
            completedTaskCount: 0,
            failedTaskCount: 0,
            nativeSidecarStatus: 'mock',
            awaiting: {
                reason: 'subagent',
                source: {
                    jobId: 'job_1',
                    childSessionId: 'session_child_1',
                },
            },
        });

        expect(session.status).toBe('awaiting');
        expect(snapshot.awaiting?.reason).toBe('subagent');
    });

    it('parses awaiting reason source metadata for every wait class', () => {
        const approval = SessionAwaitingDetailsSchema.parse({
            reason: 'approval',
            source: {
                approvalId: 'approval_1',
                runId: 'run_1',
                toolCallId: 'tool_call_1',
            },
        });
        const userInput = SessionAwaitingDetailsSchema.parse({
            reason: 'user_input',
            source: {
                inputId: 'operator_prompt',
                runId: 'run_2',
                toolCallId: 'tool_call_2',
            },
        });
        const subagent = SessionAwaitingDetailsSchema.parse({
            reason: 'subagent',
            source: {
                runId: 'run_3',
                jobId: 'job_1',
                childSessionId: 'session_child_1',
            },
        });

        expect(approval.source.approvalId).toBe('approval_1');
        expect(userInput.reason).toBe('user_input');
        expect(userInput.source.inputId).toBe('operator_prompt');
        expect(subagent.source.childSessionId).toBe('session_child_1');
        expect(SessionAwaitingSourceSchema.parse({ runId: 'run_4' })).toEqual({ runId: 'run_4' });
    });

    it('rejects invalid awaiting reason and source metadata pairs', () => {
        const invalidRows = [
            {
                reason: 'approval',
                source: {
                    childSessionId: 'session_child_1',
                },
            },
            {
                reason: 'user_input',
                source: {
                    approvalId: 'approval_1',
                },
            },
            {
                reason: 'subagent',
                source: {
                    approvalId: 'approval_2',
                    childSessionId: 'session_child_2',
                },
            },
            {
                reason: 'subagent',
                source: {
                    runId: 'run_without_child_or_job',
                },
            },
            {
                reason: 'unknown',
                source: {
                    runId: 'run_1',
                },
            },
        ];

        expect(SessionStatusSchema.safeParse('blocked_on_operator').success).toBe(false);
        expect(
            AgentSessionSchema.safeParse({
                id: 'session_missing_awaiting',
                status: 'awaiting',
                startedAt: '2026-06-02T10:00:00.000Z',
            }).success,
        ).toBe(false);
        expect(
            AgentSnapshotSchema.safeParse({
                sessionId: 'session_idle_with_awaiting',
                status: 'idle',
                startedAt: '2026-06-02T10:00:00.000Z',
                runningTaskCount: 0,
                completedTaskCount: 0,
                failedTaskCount: 0,
                nativeSidecarStatus: 'mock',
                awaiting: {
                    reason: 'user_input',
                    source: {
                        runId: 'run_1',
                    },
                },
            }).success,
        ).toBe(false);

        for (const row of invalidRows) {
            expect(SessionAwaitingDetailsSchema.safeParse(row).success).toBe(false);
        }
    });
});
