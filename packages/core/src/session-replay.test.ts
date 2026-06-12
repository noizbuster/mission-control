import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    parseJsonlSessionLog,
    serializeJsonlRecord,
} from './memory/jsonl-session-records.js';
import { SessionEventLog } from './session-log.js';
import { projectJsonlSessionReplayPrefix, projectSessionReplay } from './session-replay.js';

describe('session replay projectors', () => {
    it('reconstructs the same ABG timeline and graph snapshot as the live log', () => {
        // Given
        const sessionId = 'session_replay_graph';
        const events: readonly AgentEvent[] = [
            graphEvent('graph.started', sessionId, 'graph started'),
            nodeEvent('node.started', sessionId, 'node_llm', 'started'),
            nodeEvent('node.completed', sessionId, 'node_llm', 'success'),
            graphEvent('graph.completed', sessionId, 'graph completed'),
        ];
        const liveLog = new SessionEventLog();
        for (const event of events) liveLog.append(event);

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
                expect.objectContaining({ eventId: 'event_root', childEventIds: ['event_branch_a', 'event_branch_b'] }),
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

    it('rejects corrupt jsonl records', () => {
        // Given
        const sessionId = 'session_replay_corrupt_jsonl';
        const filePath = `${sessionId}.jsonl`;
        const contents = [
            serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: '2026-06-05T10:00:00.000Z' })),
            serializeJsonlRecord(
                createJsonlSessionEventRecord(envelope(taskEvent(sessionId, 'task_1', 'safe prefix'), 0)),
            ),
            '{"broken":\n',
        ].join('');

        // When
        const replay = projectJsonlSessionReplayPrefix({ sessionId, contents });

        // Then
        expect(() => parseJsonlSessionLog({ sessionId, filePath, contents })).toThrow(
            expect.objectContaining({ code: 'corrupt_line', lineNumber: 3, sessionId }),
        );
        expect(replay.projection.events).toEqual([taskEvent(sessionId, 'task_1', 'safe prefix')]);
        expect(replay.diagnostics).toEqual([{ code: 'corrupt_trailing_record', lineNumber: 3, sessionId }]);
    });
});

type EnvelopeOptions = { readonly eventId?: string; readonly causationId?: string };

function envelope(event: AgentEvent, sequence: number, options: EnvelopeOptions = {}): AgentEventEnvelope {
    return {
        eventId: options.eventId ?? `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
        event,
    };
}

function graphEvent(type: 'graph.started' | 'graph.completed', sessionId: string, message: string): AgentEvent {
    return {
        type,
        timestamp: type === 'graph.started' ? '2026-06-05T10:00:00.000Z' : '2026-06-05T10:00:03.000Z',
        sessionId,
        message,
        abg: { graphId: 'graph_replay' },
    };
}

function nodeEvent(
    type: 'node.started' | 'node.completed',
    sessionId: string,
    nodeId: string,
    signalType: 'started' | 'success',
): AgentEvent {
    return {
        type,
        timestamp: type === 'node.started' ? '2026-06-05T10:00:01.000Z' : '2026-06-05T10:00:02.000Z',
        sessionId,
        message: type === 'node.started' ? 'node started' : 'node completed',
        abg: {
            graphId: 'graph_replay',
            nodeId,
            signalType,
            ...(type === 'node.completed' ? { model: { providerID: 'local', modelID: 'local-echo' } } : {}),
        },
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
