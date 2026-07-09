/** @jsxImportSource @opentui/solid */

import {
    type ApprovalProjection,
    projectSessionReplay,
    type SessionReplayProjection,
    type ToolOutcomeProjection,
} from '@mission-control/core';
import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventSchema,
    type AgentSession,
    type AgentSnapshot,
    type SessionAwaitingDetails,
} from '@mission-control/protocol';
import { type Accessor, createMemo, type JSX } from 'solid-js';
import type { ChatStore } from '../../state/chat-store.js';
import { useSolidStoreSelector } from '../use-solid-store-selector.js';
import { createRequiredContext } from './context-base.js';
import { useTuiPaths, useTuiRuntime } from './runtime-context.js';
import { useTuiRuntimeEvents } from './runtime-events-context.js';

export type TuiRuntimeEventProjection = Pick<
    SessionReplayProjection,
    'events' | 'snapshot' | 'timeline' | 'graphSnapshots' | 'approvals' | 'toolOutcomes'
> & {
    readonly session: AgentSession;
};

export type TuiProjectService = {
    readonly workspaceRoot: string;
    readonly workspaceName: string;
    readonly gitBranch?: string;
    readonly isWorktree: boolean;
    readonly sessionID: Accessor<string | undefined>;
};

export type TuiEventsService = {
    readonly events: Accessor<readonly AgentEvent[]>;
    readonly latestEvent: Accessor<AgentEvent | undefined>;
    readonly toolOutcomes: Accessor<readonly ToolOutcomeProjection[]>;
    readonly approvals: Accessor<readonly ApprovalProjection[]>;
    readonly timeline: Accessor<TuiRuntimeEventProjection['timeline']>;
    readonly graphSnapshots: Accessor<TuiRuntimeEventProjection['graphSnapshots']>;
    readonly projection: Accessor<TuiRuntimeEventProjection>;
};

export type TuiSyncService = {
    readonly ready: Promise<void>;
    readonly reloadSnapshot: () => Promise<void>;
    readonly snapshot: Accessor<AgentSnapshot | undefined>;
    readonly session: Accessor<AgentSession>;
    readonly awaiting: Accessor<SessionAwaitingDetails | undefined>;
};

export type MissionControlProjectSyncProviderProps = {
    readonly chatStore?: ChatStore;
    readonly children: JSX.Element;
};

const TuiProjectContext = createRequiredContext<TuiProjectService>('TuiProject');
const TuiEventsContext = createRequiredContext<TuiEventsService>('TuiEvents');
const TuiSyncContext = createRequiredContext<TuiSyncService>('TuiSync');

export function useTuiProject(): TuiProjectService {
    return TuiProjectContext.useValue();
}

export function useTuiEvents(): TuiEventsService {
    return TuiEventsContext.useValue();
}

export function useTuiSync(): TuiSyncService {
    return TuiSyncContext.useValue();
}

export function MissionControlProjectSyncProvider(props: MissionControlProjectSyncProviderProps): JSX.Element {
    const service = createProjectSyncServices(props.chatStore);
    return (
        <TuiProjectContext.Provider value={service.project}>
            <TuiEventsContext.Provider value={service.events}>
                <TuiSyncContext.Provider value={service.sync}>{props.children}</TuiSyncContext.Provider>
            </TuiEventsContext.Provider>
        </TuiProjectContext.Provider>
    );
}

export function projectTuiRuntimeEvents(input: {
    readonly sessionId: string;
    readonly events: readonly unknown[];
}): TuiRuntimeEventProjection {
    const events = deduplicateEvents(parseAgentEvents(input.events));
    const projection = projectSessionReplay({
        sessionId: input.sessionId,
        envelopes: events.map((event, index) => eventEnvelopeFor(event, index, input.sessionId)),
    });
    return {
        events: projection.events,
        snapshot: projection.snapshot,
        timeline: projection.timeline,
        graphSnapshots: projection.graphSnapshots,
        approvals: projection.approvals,
        toolOutcomes: projection.toolOutcomes,
        session: sessionFromSnapshot(projection.snapshot),
    };
}

function createProjectSyncServices(chatStore: ChatStore | undefined): {
    readonly project: TuiProjectService;
    readonly events: TuiEventsService;
    readonly sync: TuiSyncService;
} {
    const runtime = useTuiRuntime();
    const paths = useTuiPaths();
    const runtimeEvents = useTuiRuntimeEvents();
    const chatSessionId = chatStore ? useSolidStoreSelector(chatStore, (s) => s.sessionId) : () => '';

    const sessionID = (): string | undefined => {
        const snapshotSessionId = runtimeEvents.snapshot()?.sessionId;
        if (snapshotSessionId !== undefined) return snapshotSessionId;
        const storeSessionId = chatSessionId();
        if (storeSessionId.length > 0) return storeSessionId;
        return runtime.sessionID;
    };
    const projection = createMemo(() =>
        projectTuiRuntimeEvents({
            sessionId: sessionID() ?? 'tui-session',
            events: runtimeEvents.events(),
        }),
    );
    const session = (): AgentSession => sessionFromSnapshot(runtimeEvents.snapshot(), projection().session);
    const project: TuiProjectService = Object.freeze({
        workspaceRoot: paths.workspaceRoot,
        workspaceName: workspaceNameFromPath(paths.workspaceRoot),
        ...(runtime.gitBranch !== undefined ? { gitBranch: runtime.gitBranch } : {}),
        isWorktree: runtime.isWorktree,
        sessionID,
    });
    const events: TuiEventsService = Object.freeze({
        events: () => projection().events,
        latestEvent: () => projection().events.at(-1),
        toolOutcomes: () => projection().toolOutcomes,
        approvals: () => projection().approvals,
        timeline: () => projection().timeline,
        graphSnapshots: () => projection().graphSnapshots,
        projection,
    });
    const sync: TuiSyncService = Object.freeze({
        ready: runtimeEvents.ready,
        reloadSnapshot: runtimeEvents.reloadSnapshot,
        snapshot: runtimeEvents.snapshot,
        session,
        awaiting: () => session().awaiting,
    });
    return { project, events, sync };
}

function parseAgentEvents(events: readonly unknown[]): readonly AgentEvent[] {
    return events.flatMap((event) => {
        const parsed = AgentEventSchema.safeParse(event);
        return parsed.success ? [parsed.data] : [];
    });
}

function deduplicateEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
    const seen = new Set<string>();
    const uniqueEvents: AgentEvent[] = [];
    for (const event of events) {
        const key = eventDeduplicationKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueEvents.push(event);
    }
    return uniqueEvents;
}

function eventEnvelopeFor(event: AgentEvent, index: number, sessionId: string): AgentEventEnvelope {
    const eventWithSession: AgentEvent = {
        ...event,
        durability: 'durable',
        sessionId,
    };
    return {
        eventId: `tui-${index}`,
        sequence: index,
        createdAt: event.timestamp,
        sessionId,
        durability: 'durable',
        event: eventWithSession,
    };
}

function sessionFromSnapshot(snapshot: AgentSnapshot): AgentSession;
function sessionFromSnapshot(snapshot: AgentSnapshot | undefined, fallback: AgentSession): AgentSession;
function sessionFromSnapshot(snapshot: AgentSnapshot | undefined, fallback?: AgentSession): AgentSession {
    if (snapshot === undefined) {
        if (fallback !== undefined) return fallback;
        return {
            id: 'tui-session',
            status: 'idle',
            startedAt: new Date(0).toISOString(),
        };
    }
    return {
        id: snapshot.sessionId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        ...(snapshot.awaiting !== undefined ? { awaiting: snapshot.awaiting } : {}),
        ...(snapshot.stoppedAt !== undefined ? { stoppedAt: snapshot.stoppedAt } : {}),
    };
}

function workspaceNameFromPath(path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/\/+$/u, '');
    const segments = normalized.split('/');
    return segments.at(-1) ?? normalized;
}

function eventDeduplicationKey(event: AgentEvent): string {
    return [
        event.type,
        event.timestamp,
        event.sessionId ?? '',
        event.taskId ?? '',
        event.message ?? '',
        event.abg?.graphId ?? '',
        event.abg?.nodeId ?? '',
        event.abg?.signalType ?? '',
        event.abg?.emit?.type ?? '',
        event.toolResult?.toolCallId ?? '',
        event.toolResult?.status ?? '',
        event.approvalRecord?.approvalId ?? '',
        event.approvalRecord?.state ?? '',
        event.approvalRecord?.decidedAt ?? '',
        event.nativeSidecarStatus ?? '',
        event.providerStreamChunk?.kind ?? '',
        providerStreamChunkKey(event),
    ].join('\u001f');
}

function providerStreamChunkKey(event: AgentEvent): string {
    const chunk = event.providerStreamChunk;
    if (chunk === undefined) return '';
    switch (chunk.kind) {
        case 'response_started':
        case 'response_completed':
        case 'response_failed':
            return `${chunk.requestId}:${chunk.sequence}`;
        case 'text_delta':
        case 'reasoning_delta':
            return `${chunk.requestId}:${chunk.sequence}:${chunk.delta}`;
        case 'reasoning_completed':
            return `${chunk.requestId}:${chunk.sequence}:${chunk.text}`;
        case 'tool_call_delta':
            return `${chunk.requestId}:${chunk.sequence}:${chunk.toolCallId}:${chunk.argumentsDelta}`;
        case 'tool_call_completed':
            return `${chunk.requestId}:${chunk.sequence}:${chunk.toolCall.toolCallId}`;
        default:
            return assertNever(chunk);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unhandled provider stream chunk: ${String(value)}`);
}
