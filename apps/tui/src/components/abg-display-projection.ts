import type { AbgToolOutcomeSnapshot, ApprovalRecord } from '@mission-control/protocol';
import type { AbgOverlayState, RecentEvent } from '../state/abg-overlay-state';
import { sanitizeTerminalDisplayText } from '../state/terminal-display-sanitizer';
import { renderVisualGraph, type VisualGraphInput, type VisualGraphRender } from './visual-graph';

type DisplayLabelContext = {
    readonly baseLabel: string;
    readonly labelIndex: number;
    readonly labelCount: number;
    readonly reservedLabels: ReadonlySet<string>;
    readonly usedLabels: ReadonlySet<string>;
};

type AbgGraphRenderInput = {
    readonly state: AbgOverlayState;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly offsetX: number;
    readonly offsetY: number;
};

export function sanitizeAbgDisplayText(text: string): string {
    return sanitizeTerminalDisplayText(text);
}

export function sanitizeAbgGraphLabel(text: string): string {
    return sanitizeAbgDisplayText(text).replaceAll('\n', '\\u{000A}');
}

export function projectVisualGraphInputForDisplay(input: VisualGraphInput): VisualGraphInput {
    const rawIdentifiers = new Set<string>(input.nodes.map((node) => node.nodeId));
    for (const edge of input.edges) {
        rawIdentifiers.add(edge.from);
        rawIdentifiers.add(edge.to);
    }
    if (input.entryNodeId !== undefined) rawIdentifiers.add(input.entryNodeId);

    const orderedIdentifiers = [...rawIdentifiers].sort(compareRawText);
    const labelCounts = new Map<string, number>();
    for (const identifier of orderedIdentifiers) {
        const label = sanitizeAbgGraphLabel(identifier);
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const labelIndexes = new Map<string, number>();
    const reservedLabels = new Set(labelCounts.keys());
    const usedLabels = new Set<string>();
    const displayIdByRawId = new Map<string, string>();
    for (const identifier of orderedIdentifiers) {
        const baseLabel = sanitizeAbgGraphLabel(identifier);
        const labelCount = labelCounts.get(baseLabel) ?? 1;
        const labelIndex = (labelIndexes.get(baseLabel) ?? 0) + 1;
        labelIndexes.set(baseLabel, labelIndex);
        const displayId = nextDisplayLabel({ baseLabel, labelIndex, labelCount, reservedLabels, usedLabels });
        usedLabels.add(displayId);
        displayIdByRawId.set(identifier, displayId);
    }

    return {
        ...input,
        nodes: input.nodes.map((node) => ({
            ...node,
            nodeId: displayIdByRawId.get(node.nodeId) ?? node.nodeId,
        })),
        edges: input.edges.map((edge) => ({
            ...edge,
            from: displayIdByRawId.get(edge.from) ?? edge.from,
            to: displayIdByRawId.get(edge.to) ?? edge.to,
            ...(edge.label === undefined ? {} : { label: sanitizeAbgGraphLabel(edge.label) }),
        })),
        ...(input.entryNodeId === undefined
            ? {}
            : { entryNodeId: displayIdByRawId.get(input.entryNodeId) ?? input.entryNodeId }),
    };
}

export function renderAbgGraphForDisplay(input: AbgGraphRenderInput): VisualGraphRender {
    const { state, maxWidth, maxHeight, offsetX, offsetY } = input;
    return renderVisualGraph(
        projectVisualGraphInputForDisplay({
            nodes: [...state.nodes].map(([nodeId, status]) => ({
                nodeId,
                status,
                isActive: state.activeNodeIds.includes(nodeId),
            })),
            edges: state.graphEdges.map((edge) => ({
                from: edge.source,
                to: edge.target,
                ...(edge.condition === undefined ? {} : { label: edge.condition }),
            })),
            maxWidth,
            maxHeight,
            offsetX,
            offsetY,
        }),
    );
}

export function projectBlackboardEntriesForDisplay(entries: ReadonlyMap<string, unknown>): ReadonlyMap<string, string> {
    const orderedEntries = [...entries.entries()].sort(([left], [right]) => compareRawText(left, right));
    const labelCounts = new Map<string, number>();
    for (const [key] of orderedEntries) {
        const label = sanitizeAbgDisplayText(key);
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const labelIndexes = new Map<string, number>();
    const reservedLabels = new Set(labelCounts.keys());
    const usedLabels = new Set<string>();
    const projected = new Map<string, string>();
    for (const [key, value] of orderedEntries) {
        const baseLabel = sanitizeAbgDisplayText(key);
        const labelCount = labelCounts.get(baseLabel) ?? 1;
        const labelIndex = (labelIndexes.get(baseLabel) ?? 0) + 1;
        labelIndexes.set(baseLabel, labelIndex);
        const displayLabel = nextDisplayLabel({ baseLabel, labelIndex, labelCount, reservedLabels, usedLabels });
        usedLabels.add(displayLabel);
        projected.set(displayLabel, sanitizeAbgDisplayText(formatBlackboardValue(value)));
    }
    return projected;
}

export function projectAbgPaneBStateForDisplay(state: AbgOverlayState): AbgOverlayState {
    return {
        ...state,
        toolOutcomes: state.toolOutcomes.map(projectToolOutcomeForDisplay),
        recentEvents: state.recentEvents.map(projectRecentEventForDisplay),
        pendingApprovals: state.pendingApprovals.map(projectApprovalForDisplay),
        blackboardEntries: projectBlackboardEntriesForDisplay(state.blackboardEntries),
    };
}

function projectToolOutcomeForDisplay(outcome: AbgToolOutcomeSnapshot): AbgToolOutcomeSnapshot {
    return {
        ...outcome,
        toolId: sanitizeAbgDisplayText(outcome.toolId),
        ...(outcome.startedAt === undefined ? {} : { startedAt: sanitizeAbgDisplayText(outcome.startedAt) }),
        ...(outcome.completedAt === undefined ? {} : { completedAt: sanitizeAbgDisplayText(outcome.completedAt) }),
        ...(outcome.failedAt === undefined ? {} : { failedAt: sanitizeAbgDisplayText(outcome.failedAt) }),
        ...(outcome.lastMessage === undefined ? {} : { lastMessage: sanitizeAbgDisplayText(outcome.lastMessage) }),
    };
}

function projectRecentEventForDisplay(event: RecentEvent): RecentEvent {
    return {
        ...event,
        timestamp: sanitizeAbgDisplayText(event.timestamp),
        type: sanitizeAbgDisplayText(event.type),
        message: sanitizeAbgDisplayText(event.message),
        ...(event.nodeId === undefined ? {} : { nodeId: sanitizeAbgDisplayText(event.nodeId) }),
        ...(event.signal === undefined ? {} : { signal: sanitizeAbgDisplayText(event.signal) }),
        ...(event.emitPayloadText === undefined
            ? {}
            : { emitPayloadText: sanitizeAbgDisplayText(event.emitPayloadText) }),
    };
}

function projectApprovalForDisplay(approval: ApprovalRecord): ApprovalRecord {
    return {
        ...approval,
        approvalId: sanitizeAbgDisplayText(approval.approvalId),
        requestedAt: sanitizeAbgDisplayText(approval.requestedAt),
        subject: { ...approval.subject, id: sanitizeAbgDisplayText(approval.subject.id) },
        ...(approval.reason === undefined ? {} : { reason: sanitizeAbgDisplayText(approval.reason) }),
    };
}

function compareRawText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function nextDisplayLabel(context: DisplayLabelContext): string {
    const { baseLabel, labelIndex, labelCount, reservedLabels, usedLabels } = context;
    let collisionAttempt = 1;
    let candidate = labelCount === 1 ? baseLabel : `${baseLabel} [${labelIndex}/${labelCount}]`;
    while (usedLabels.has(candidate) || (candidate !== baseLabel && reservedLabels.has(candidate))) {
        collisionAttempt++;
        candidate = `${baseLabel} [${labelIndex}/${labelCount};${collisionAttempt}]`;
    }
    return candidate;
}

function formatBlackboardValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? 'undefined';
    } catch {
        return '[unserializable]';
    }
}
