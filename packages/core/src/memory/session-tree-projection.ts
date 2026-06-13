import { type AgentEventEnvelope, AgentEventLogSchema, type SessionTreeEventMetadata } from '@mission-control/protocol';
import type {
    SessionTreeArchiveExport,
    SessionTreeArchiveImport,
    SessionTreeCompactionBoundary,
    SessionTreeNode,
    SessionTreeProjection,
    SessionTreeProjectionDiagnostic,
} from '../session-replay-types.js';

type MutableSessionTreeNode = {
    readonly entryId: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly parentEntryId?: string;
    readonly childEntryIds: string[];
    readonly eventType: AgentEventEnvelope['event']['type'];
    readonly timestamp: string;
    readonly message?: string;
};

type ProjectionState = {
    readonly sessionId: string;
    readonly nodesByEntryId: Map<string, MutableSessionTreeNode>;
    readonly entryIdByEventId: Map<string, string>;
    readonly compactionBoundaries: SessionTreeCompactionBoundary[];
    readonly exports: SessionTreeArchiveExport[];
    readonly imports: SessionTreeArchiveImport[];
    readonly diagnostics: SessionTreeProjectionDiagnostic[];
    sessionName?: string;
    cwd?: string;
    trustedRoot?: string;
    workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    parentSessionId?: string;
    activeLeafId?: string;
    forkSource?: SessionTreeProjection['forkSource'];
    cloneSource?: SessionTreeProjection['cloneSource'];
    previousEntryId?: string;
};

export function projectSessionTree(input: {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): SessionTreeProjection {
    const envelopes = AgentEventLogSchema.parse(input.envelopes).filter(
        (envelope) =>
            envelope.durability === 'durable' &&
            envelope.sessionId === input.sessionId &&
            envelope.event.sessionId === input.sessionId,
    );
    const state: ProjectionState = {
        sessionId: input.sessionId,
        nodesByEntryId: new Map(),
        entryIdByEventId: new Map(),
        compactionBoundaries: [],
        exports: [],
        imports: [],
        diagnostics: [],
    };

    for (const envelope of envelopes) {
        applyEnvelope(state, envelope);
    }
    linkChildEntries(state);

    return {
        sessionId: input.sessionId,
        ...(state.sessionName !== undefined ? { sessionName: state.sessionName } : {}),
        ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
        ...(state.trustedRoot !== undefined ? { trustedRoot: state.trustedRoot } : {}),
        ...(state.workspaceTrust !== undefined ? { workspaceTrust: state.workspaceTrust } : {}),
        ...(state.parentSessionId !== undefined ? { parentSessionId: state.parentSessionId } : {}),
        ...(state.activeLeafId !== undefined ? { activeLeafId: state.activeLeafId } : {}),
        ...(state.forkSource !== undefined ? { forkSource: state.forkSource } : {}),
        ...(state.cloneSource !== undefined ? { cloneSource: state.cloneSource } : {}),
        nodes: [...state.nodesByEntryId.values()].map(toReadonlyNode),
        compactionBoundaries: [...state.compactionBoundaries],
        exports: [...state.exports],
        imports: [...state.imports],
        diagnostics: [...state.diagnostics],
    };
}

function applyEnvelope(state: ProjectionState, envelope: AgentEventEnvelope): void {
    const metadata = envelope.event.sessionTree;
    if (metadata === undefined) {
        addEntryNode(state, envelope, {
            entryId: envelope.eventId,
            parentEntryId: parentEntryIdFor(state, envelope, undefined),
            active: false,
        });
        return;
    }

    switch (metadata.kind) {
        case 'entry':
            addEntryNode(state, envelope, {
                entryId: metadata.entryId,
                parentEntryId: parentEntryIdFor(state, envelope, metadata.parentEntryId),
                active: metadata.active ?? true,
            });
            return;
        case 'metadata':
            applyMetadataUpdate(state, metadata);
            return;
        case 'fork':
            state.forkSource = metadata.source;
            if (metadata.parentSessionId !== undefined) {
                state.parentSessionId = metadata.parentSessionId;
            }
            return;
        case 'clone':
            state.cloneSource = metadata.source;
            if (metadata.parentSessionId !== undefined) {
                state.parentSessionId = metadata.parentSessionId;
            }
            return;
        case 'active_leaf':
            state.activeLeafId = metadata.entryId;
            return;
        case 'compaction':
            state.compactionBoundaries.push({
                eventId: envelope.eventId,
                sequence: envelope.sequence,
                timestamp: envelope.event.timestamp,
                boundaryEntryId: metadata.boundaryEntryId,
                firstKeptEntryId: metadata.firstKeptEntryId,
                ...(metadata.boundarySequence !== undefined ? { boundarySequence: metadata.boundarySequence } : {}),
                ...(metadata.firstKeptSequence !== undefined ? { firstKeptSequence: metadata.firstKeptSequence } : {}),
                ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
            });
            return;
        case 'export':
            state.exports.push({
                eventId: envelope.eventId,
                sequence: envelope.sequence,
                timestamp: envelope.event.timestamp,
                manifest: metadata.manifest,
            });
            return;
        case 'import':
            state.imports.push({
                eventId: envelope.eventId,
                sequence: envelope.sequence,
                timestamp: envelope.event.timestamp,
                manifest: metadata.manifest,
                ...(metadata.sourceSessionId !== undefined ? { sourceSessionId: metadata.sourceSessionId } : {}),
            });
            return;
        default:
            assertNever(metadata);
    }
}

function addEntryNode(
    state: ProjectionState,
    envelope: AgentEventEnvelope,
    input: { readonly entryId: string; readonly parentEntryId: string | undefined; readonly active: boolean },
): void {
    if (state.nodesByEntryId.has(input.entryId)) {
        state.diagnostics.push({
            code: 'duplicate_entry_id',
            sessionId: state.sessionId,
            entryId: input.entryId,
            eventId: envelope.eventId,
        });
        return;
    }

    state.nodesByEntryId.set(input.entryId, {
        entryId: input.entryId,
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        ...(input.parentEntryId !== undefined ? { parentEntryId: input.parentEntryId } : {}),
        childEntryIds: [],
        eventType: envelope.event.type,
        timestamp: envelope.event.timestamp,
        ...(envelope.event.message !== undefined ? { message: envelope.event.message } : {}),
    });
    state.entryIdByEventId.set(envelope.eventId, input.entryId);
    state.previousEntryId = input.entryId;
    if (input.active) {
        state.activeLeafId = input.entryId;
    }
}

function applyMetadataUpdate(
    state: ProjectionState,
    metadata: Extract<SessionTreeEventMetadata, { kind: 'metadata' }>,
) {
    if (metadata.name !== undefined) {
        state.sessionName = metadata.name;
    }
    if (metadata.cwd !== undefined) {
        state.cwd = metadata.cwd;
    }
    if (metadata.trustedRoot !== undefined) {
        state.trustedRoot = metadata.trustedRoot;
    }
    if (metadata.workspaceTrust !== undefined) {
        state.workspaceTrust = metadata.workspaceTrust;
    }
    if (metadata.parentSessionId !== undefined) {
        state.parentSessionId = metadata.parentSessionId;
    }
}

function parentEntryIdFor(
    state: ProjectionState,
    envelope: AgentEventEnvelope,
    explicitParentEntryId: string | undefined,
): string | undefined {
    if (explicitParentEntryId !== undefined) {
        return explicitParentEntryId;
    }
    if (envelope.causationId !== undefined) {
        return state.entryIdByEventId.get(envelope.causationId);
    }
    return state.previousEntryId;
}

function linkChildEntries(state: ProjectionState): void {
    for (const node of state.nodesByEntryId.values()) {
        if (node.parentEntryId === undefined) {
            continue;
        }
        const parent = state.nodesByEntryId.get(node.parentEntryId);
        if (parent === undefined) {
            state.diagnostics.push({
                code: 'missing_parent_entry',
                sessionId: state.sessionId,
                entryId: node.entryId,
                parentEntryId: node.parentEntryId,
            });
            continue;
        }
        parent.childEntryIds.push(node.entryId);
    }
}

function toReadonlyNode(node: MutableSessionTreeNode): SessionTreeNode {
    return {
        entryId: node.entryId,
        eventId: node.eventId,
        sequence: node.sequence,
        ...(node.parentEntryId !== undefined ? { parentEntryId: node.parentEntryId } : {}),
        childEntryIds: [...node.childEntryIds],
        eventType: node.eventType,
        timestamp: node.timestamp,
        ...(node.message !== undefined ? { message: node.message } : {}),
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled session tree metadata kind: ${JSON.stringify(value)}`);
}
