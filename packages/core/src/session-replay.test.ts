import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { SessionEventLog } from './session-log.js';
import { projectSessionReplay } from './session-replay.js';

describe('session replay projectors', () => {
    it('reconstructs the same ABG timeline and graph snapshot as the live log', () => {
        // Given
        const sessionId = 'session_replay_graph';
        const events: readonly AgentEvent[] = [
            {
                type: 'graph.started',
                timestamp: '2026-06-05T10:00:00.000Z',
                sessionId,
                message: 'graph started',
                abg: {
                    graphId: 'graph_replay',
                },
            },
            {
                type: 'node.started',
                timestamp: '2026-06-05T10:00:01.000Z',
                sessionId,
                message: 'node started',
                abg: {
                    graphId: 'graph_replay',
                    nodeId: 'node_llm',
                    signalType: 'started',
                },
            },
            {
                type: 'node.completed',
                timestamp: '2026-06-05T10:00:02.000Z',
                sessionId,
                message: 'node completed',
                abg: {
                    graphId: 'graph_replay',
                    nodeId: 'node_llm',
                    signalType: 'success',
                    model: {
                        providerID: 'local',
                        modelID: 'local-echo',
                    },
                },
            },
            {
                type: 'graph.completed',
                timestamp: '2026-06-05T10:00:03.000Z',
                sessionId,
                message: 'graph completed',
                abg: {
                    graphId: 'graph_replay',
                },
            },
        ];
        const liveLog = new SessionEventLog();
        for (const event of events) {
            liveLog.append(event);
        }

        // When
        const replay = projectSessionReplay({
            sessionId,
            envelopes: events.map((event, sequence) => envelope(event, sequence)),
        });

        // Then
        expect(replay.timeline).toEqual(liveLog.getTimeline());
        expect(replay.graphSnapshots).toEqual([liveLog.getGraphSnapshot('graph_replay')]);
    });

    it('derives branch summaries and active leaf from causation ids', () => {
        // Given
        const sessionId = 'session_replay_branches';
        const envelopes = [
            envelope(taskEvent(sessionId, 'task_root', 'root prompt'), 0, { eventId: 'event_root' }),
            envelope(taskEvent(sessionId, 'task_a', 'assistant branch A'), 1, {
                eventId: 'event_branch_a',
                causationId: 'event_root',
            }),
            envelope(taskEvent(sessionId, 'task_b', 'assistant branch B'), 2, {
                eventId: 'event_branch_b',
                causationId: 'event_root',
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.branchTree.activeLeafId).toBe('event_branch_b');
        expect(replay.branchTree.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    eventId: 'event_root',
                    childEventIds: ['event_branch_a', 'event_branch_b'],
                }),
            ]),
        );
        expect(replay.branchSummaries).toEqual([
            {
                leafEventId: 'event_branch_a',
                eventIds: ['event_root', 'event_branch_a'],
                eventCount: 2,
                lastMessage: 'assistant branch A',
            },
            {
                leafEventId: 'event_branch_b',
                eventIds: ['event_root', 'event_branch_b'],
                eventCount: 2,
                lastMessage: 'assistant branch B',
            },
        ]);
    });

    it('derives latest approvals and tool outcomes from durable events', () => {
        // Given
        const sessionId = 'session_replay_approval_tool';
        const envelopes = [
            envelope(
                {
                    type: 'approval.requested',
                    timestamp: '2026-06-05T10:00:00.000Z',
                    sessionId,
                    message: 'approval requested',
                    approvalRecord: {
                        approvalId: 'approval_patch',
                        requestId: 'permission_patch',
                        policyDecision: 'requires_approval',
                        state: 'pending',
                        subject: {
                            kind: 'tool',
                            id: 'file.patch',
                        },
                        requestedAt: '2026-06-05T10:00:00.000Z',
                        reason: 'patch requires approval',
                    },
                },
                0,
                { eventId: 'event_approval_requested' },
            ),
            envelope(
                {
                    type: 'approval.updated',
                    timestamp: '2026-06-05T10:00:01.000Z',
                    sessionId,
                    message: 'approval approved',
                    approvalRecord: {
                        approvalId: 'approval_patch',
                        requestId: 'permission_patch',
                        policyDecision: 'requires_approval',
                        state: 'approved',
                        subject: {
                            kind: 'tool',
                            id: 'file.patch',
                        },
                        requestedAt: '2026-06-05T10:00:00.000Z',
                        decidedAt: '2026-06-05T10:00:01.000Z',
                        reason: 'approved by tester',
                    },
                },
                1,
                { eventId: 'event_approval_updated' },
            ),
            envelope(toolEvent('tool.started', sessionId, 'tool_patch', 'patch started'), 2, {
                eventId: 'event_tool_started',
            }),
            envelope(toolEvent('tool.completed', sessionId, 'tool_patch', 'patch completed'), 3, {
                eventId: 'event_tool_completed',
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.approvals).toMatchObject([
            {
                approvalId: 'approval_patch',
                state: 'approved',
            },
        ]);
        expect(replay.toolOutcomes).toEqual([
            {
                toolId: 'tool_patch',
                status: 'completed',
                startedAt: '2026-06-05T10:00:02.000Z',
                completedAt: '2026-06-05T10:00:03.000Z',
                lastMessage: 'patch completed',
            },
        ]);
    });

    it('projects replayable failed tool settlements with partial applied files', () => {
        // Given
        const sessionId = 'session_replay_partial_tool';
        const failedResult = {
            toolCallId: 'tool_patch_partial',
            status: 'failed' as const,
            error: {
                code: 'tool_failed' as const,
                message: 'partial_failed: applied a.txt; failed b.txt',
                retryable: false,
            },
        };
        const envelopes = [
            envelope(
                {
                    type: 'file.diff.applied',
                    timestamp: '2026-06-05T10:00:02.000Z',
                    sessionId,
                    taskId: 'tool_patch_partial',
                    message: 'patch partially applied',
                    nativeSidecarStatus: 'mock',
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
                },
                0,
            ),
            envelope(
                {
                    type: 'tool.failed',
                    timestamp: '2026-06-05T10:00:03.000Z',
                    sessionId,
                    taskId: 'tool_patch_partial',
                    message: 'tool failed: file.patch',
                    nativeSidecarStatus: 'mock',
                    toolResult: failedResult,
                },
                1,
            ),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.toolOutcomes).toEqual([
            {
                toolId: 'tool_patch_partial',
                status: 'failed',
                failedAt: '2026-06-05T10:00:03.000Z',
                lastMessage: 'tool failed: file.patch',
                result: failedResult,
                appliedFiles: ['a.txt'],
            },
        ]);
    });
});

type EnvelopeOptions = {
    readonly eventId?: string;
    readonly causationId?: string;
};

function envelope(event: AgentEvent, sequence: number, options: EnvelopeOptions = {}): AgentEventEnvelope {
    const eventId = options.eventId ?? `event_${sequence}`;
    return {
        eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
        event,
    };
}

function taskEvent(sessionId: string, taskId: string, message: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        taskId,
        message,
        nativeSidecarStatus: 'mock',
    };
}

function toolEvent(
    type: 'tool.started' | 'tool.completed' | 'tool.failed',
    sessionId: string,
    taskId: string,
    message: string,
): AgentEvent {
    return {
        type,
        timestamp: type === 'tool.started' ? '2026-06-05T10:00:02.000Z' : '2026-06-05T10:00:03.000Z',
        sessionId,
        taskId,
        message,
        nativeSidecarStatus: 'mock',
    };
}
