import {
    type AgentEvent,
    AgentEventSchema,
    type AgentEventType,
    type SessionArchiveManifest,
    type SessionTreeEventMetadata,
} from '@mission-control/protocol';
import type { SessionReplayProjection } from '../session-replay.js';

export const REPLAY_PARITY_SESSION_ID = 'session_replay_parity';

export type ReplayParitySummary = {
    readonly sequences: readonly number[];
    readonly eventIds: readonly string[];
    readonly eventTypes: readonly AgentEventType[];
    readonly snapshot: {
        readonly status: SessionReplayProjection['snapshot']['status'];
        readonly startedAt: string;
        readonly stoppedAt?: string;
        readonly completedTaskCount: number;
        readonly lastMessage?: string;
    };
    readonly sessionTree: Pick<
        SessionReplayProjection['sessionTree'],
        'activeLeafId' | 'forkSource' | 'cloneSource' | 'compactionBoundaries' | 'exports' | 'imports'
    >;
};

export function replayParityEvents(sessionId: string): readonly AgentEvent[] {
    return [
        event(sessionId, {
            type: 'session.started',
            timestamp: '2026-06-21T10:00:00.000Z',
            message: 'started parity session',
        }),
        event(sessionId, {
            type: 'task.started',
            timestamp: '2026-06-21T10:00:01.000Z',
            taskId: 'task_root',
            message: 'root prompt',
            sessionTree: { kind: 'entry', entryId: 'entry_root' },
        }),
        event(sessionId, {
            type: 'task.completed',
            timestamp: '2026-06-21T10:00:02.000Z',
            taskId: 'task_root',
            message: 'root completed',
            sessionTree: { kind: 'entry', entryId: 'entry_leaf', parentEntryId: 'entry_root', active: true },
        }),
        event(sessionId, {
            type: 'session.metadata.updated',
            timestamp: '2026-06-21T10:00:03.000Z',
            message: 'metadata updated',
            sessionTree: {
                kind: 'metadata',
                name: 'Replay parity fixture',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                workspaceTrust: 'trusted',
                parentSessionId: 'session_parent',
            },
        }),
        event(sessionId, {
            type: 'session.forked',
            timestamp: '2026-06-21T10:00:04.000Z',
            message: 'forked from parent',
            sessionTree: {
                kind: 'fork',
                parentSessionId: 'session_parent',
                source: { sessionId: 'session_parent', entryId: 'entry_parent_leaf' },
            },
        }),
        event(sessionId, {
            type: 'session.cloned',
            timestamp: '2026-06-21T10:00:05.000Z',
            message: 'cloned from template',
            sessionTree: {
                kind: 'clone',
                source: { sessionId: 'session_template', entryId: 'entry_template_leaf' },
            },
        }),
        event(sessionId, {
            type: 'session.compacted',
            timestamp: '2026-06-21T10:00:06.000Z',
            message: 'compacted fixture',
            sessionTree: {
                kind: 'compaction',
                boundaryEntryId: 'entry_root',
                firstKeptEntryId: 'entry_leaf',
                boundarySequence: 1,
                firstKeptSequence: 2,
                summary: 'kept leaf after root',
            },
        }),
        event(sessionId, {
            type: 'session.exported',
            timestamp: '2026-06-21T10:00:07.000Z',
            message: 'exported fixture',
            sessionTree: { kind: 'export', manifest: archiveManifest(sessionId, '2026-06-21T10:00:07.000Z') },
        }),
        event(sessionId, {
            type: 'session.imported',
            timestamp: '2026-06-21T10:00:08.000Z',
            message: 'imported fixture',
            sessionTree: {
                kind: 'import',
                manifest: archiveManifest(sessionId, '2026-06-21T10:00:08.000Z'),
                sourceSessionId: 'session_import_source',
            },
        }),
        event(sessionId, {
            type: 'session.stopped',
            timestamp: '2026-06-21T10:00:09.000Z',
            message: 'stopped parity session',
        }),
    ];
}

export function replayParitySummary(replay: SessionReplayProjection): ReplayParitySummary {
    return {
        sequences: replay.envelopes.map((envelope) => envelope.sequence),
        eventIds: replay.envelopes.map((envelope) => envelope.eventId),
        eventTypes: replay.events.map((event) => event.type),
        snapshot: {
            status: replay.snapshot.status,
            startedAt: replay.snapshot.startedAt,
            ...(replay.snapshot.stoppedAt !== undefined ? { stoppedAt: replay.snapshot.stoppedAt } : {}),
            completedTaskCount: replay.snapshot.completedTaskCount,
            ...(replay.snapshot.lastMessage !== undefined ? { lastMessage: replay.snapshot.lastMessage } : {}),
        },
        sessionTree: {
            ...(replay.sessionTree.activeLeafId !== undefined ? { activeLeafId: replay.sessionTree.activeLeafId } : {}),
            ...(replay.sessionTree.forkSource !== undefined ? { forkSource: replay.sessionTree.forkSource } : {}),
            ...(replay.sessionTree.cloneSource !== undefined ? { cloneSource: replay.sessionTree.cloneSource } : {}),
            compactionBoundaries: replay.sessionTree.compactionBoundaries,
            exports: replay.sessionTree.exports,
            imports: replay.sessionTree.imports,
        },
    };
}

function event(
    sessionId: string,
    input: {
        readonly type: AgentEventType;
        readonly timestamp: string;
        readonly message: string;
        readonly taskId?: string;
        readonly sessionTree?: SessionTreeEventMetadata;
    },
): AgentEvent {
    return AgentEventSchema.parse({
        type: input.type,
        timestamp: input.timestamp,
        sessionId,
        message: input.message,
        nativeSidecarStatus: 'mock',
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.sessionTree !== undefined ? { sessionTree: input.sessionTree } : {}),
    });
}

function archiveManifest(sessionId: string, createdAt: string): SessionArchiveManifest {
    return {
        schemaVersion: 1,
        sessionId,
        cwd: '/workspace/mission-control',
        trustedRoot: '/workspace/mission-control',
        createdAt,
    };
}
