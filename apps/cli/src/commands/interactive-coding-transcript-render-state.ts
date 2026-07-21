import type {
    BlockToolTranscriptPart,
    CommandTranscriptPart,
    DiffTranscriptPart,
    InlineToolTranscriptPart,
    SubagentTranscriptPart,
} from '@mission-control/tui/state';

export type ActiveToolTranscriptPart =
    | InlineToolTranscriptPart
    | BlockToolTranscriptPart
    | DiffTranscriptPart
    | CommandTranscriptPart
    | SubagentTranscriptPart;

export type ProviderRenderState = {
    readonly executionTurnId: string;
    streamingText: boolean;
    streamingTextPartId?: string;
    streamingThinking: boolean;
    streamingThinkingPartId?: string;
    finalMessage?: string;
    lastAssistantAttributionId?: string;
    readonly assistantTextByRequest: Map<string, string>;
    readonly reasoningTextByRequest: Map<string, string>;
    readonly openGraphTurnByNode: Map<string, string>;
    readonly terminalGraphTurnsByNode: Map<string, string[]>;
    readonly toolSummaryByGraphTurn: Map<string, GraphTurnToolSummary>;
    readonly activeToolTranscriptParts: Map<string, ActiveToolTranscriptPart>;
    readonly toolOccurrenceCountByRawId: Map<string, number>;
    readonly pendingToolBaseIdsByRawId: Map<string, string[]>;
    readonly liveSettledToolCallIds: Set<string>;
    graphOccurrenceOrdinal: number;
    interruptionReceiptSettled: boolean;
    lastGraphErrorEmission?: GraphErrorEmissionState;
};

export type AssistantAttributionSource = {
    readonly messageId?: string;
    readonly requestId?: string;
    readonly id: string;
};

export function noteAssistantAttribution(state: ProviderRenderState, part: AssistantAttributionSource): void {
    state.lastAssistantAttributionId = part.messageId ?? part.requestId ?? part.id;
}

export function stampToolPartAttribution(
    part: ActiveToolTranscriptPart,
    attributionId: string | undefined,
): ActiveToolTranscriptPart {
    if ('messageId' in part && part.messageId !== undefined) return part;
    if (attributionId === undefined || attributionId.length === 0) return part;
    return { ...part, messageId: attributionId };
}

export type GraphErrorEmissionState = {
    readonly reason: string;
    readonly typedPartEmitted: boolean;
    readonly exactReceiptFallbackWritten: boolean;
};

export type GraphTurnToolSummary = {
    readonly count: number;
    readonly names: readonly string[];
};

export type GraphTurnLane = 'assistant' | 'reasoning' | 'tools' | 'error';

export type ProviderTranscriptLane = 'assistant' | 'reasoning';

export function createProviderRenderState(executionTurnId: string): ProviderRenderState {
    return {
        executionTurnId,
        streamingText: false,
        streamingThinking: false,
        assistantTextByRequest: new Map(),
        reasoningTextByRequest: new Map(),
        openGraphTurnByNode: new Map(),
        terminalGraphTurnsByNode: new Map(),
        toolSummaryByGraphTurn: new Map(),
        activeToolTranscriptParts: new Map(),
        toolOccurrenceCountByRawId: new Map(),
        pendingToolBaseIdsByRawId: new Map(),
        liveSettledToolCallIds: new Set(),
        graphOccurrenceOrdinal: 0,
        interruptionReceiptSettled: false,
    };
}

export function providerTranscriptPartId(
    executionTurnId: string,
    requestId: string,
    lane: ProviderTranscriptLane,
): string {
    return `provider:${encodeURIComponent(executionTurnId)}:${encodeURIComponent(requestId)}:${lane}`;
}

export function toolTranscriptBaseId(executionTurnId: string, toolCallId: string, occurrence: number): string {
    return `tool:${encodeURIComponent(executionTurnId)}:${encodeURIComponent(toolCallId)}:occurrence:${occurrence}`;
}

export function allocateToolTranscriptOccurrence(state: ProviderRenderState, toolCallId: string): string {
    const basePartId = nextToolTranscriptOccurrence(state, toolCallId);
    const pending = state.pendingToolBaseIdsByRawId.get(toolCallId);
    if (pending === undefined) {
        state.pendingToolBaseIdsByRawId.set(toolCallId, [basePartId]);
    } else {
        pending.push(basePartId);
    }
    return basePartId;
}

export function claimToolTranscriptOccurrence(state: ProviderRenderState, toolCallId: string): string {
    const pending = state.pendingToolBaseIdsByRawId.get(toolCallId);
    const basePartId = pending?.shift();
    if (pending?.length === 0) state.pendingToolBaseIdsByRawId.delete(toolCallId);
    if (basePartId !== undefined) return basePartId;
    if (process.env['MCTRL_DEBUG_TRANSCRIPT'] === '1') {
        process.stderr.write(
            `[transcript] claimToolTranscriptOccurrence: no pending entry for toolCallId=${toolCallId}; minting new occurrence (orphan preview may stay stuck)\n`,
        );
    }
    return nextToolTranscriptOccurrence(state, toolCallId);
}

export function registerActiveToolTranscriptPart(state: ProviderRenderState, part: ActiveToolTranscriptPart): void {
    if (part.status === 'pending' || part.status === 'running' || part.status === 'streaming') {
        state.activeToolTranscriptParts.set(part.id, part);
    }
}

export function retireActiveToolTranscriptParts(state: ProviderRenderState, basePartId: string): void {
    state.activeToolTranscriptParts.delete(basePartId);
    state.activeToolTranscriptParts.delete(`${basePartId}:preview`);
}

export function settleTerminalToolTranscriptParts(
    state: ProviderRenderState,
    status: 'completed' | 'failed',
): readonly ActiveToolTranscriptPart[] {
    const terminalParts = [...state.activeToolTranscriptParts.values()].map(
        (part): ActiveToolTranscriptPart => ({ ...part, status }),
    );
    state.activeToolTranscriptParts.clear();
    state.pendingToolBaseIdsByRawId.clear();
    return terminalParts;
}

export function settleInterruptedToolTranscriptParts(
    state: ProviderRenderState,
): readonly ActiveToolTranscriptPart[] | undefined {
    if (state.interruptionReceiptSettled) return undefined;
    state.interruptionReceiptSettled = true;
    const interruptedParts = [...state.activeToolTranscriptParts.values()].map(
        (part): ActiveToolTranscriptPart => ({ ...part, status: 'interrupted' }),
    );
    state.activeToolTranscriptParts.clear();
    state.pendingToolBaseIdsByRawId.clear();
    return interruptedParts;
}

function nextToolTranscriptOccurrence(state: ProviderRenderState, toolCallId: string): string {
    const occurrence = (state.toolOccurrenceCountByRawId.get(toolCallId) ?? 0) + 1;
    state.toolOccurrenceCountByRawId.set(toolCallId, occurrence);
    return toolTranscriptBaseId(state.executionTurnId, toolCallId, occurrence);
}

export function graphOccurrencePartId(state: ProviderRenderState, stableEventId?: string): string {
    const turnId = encodeURIComponent(state.executionTurnId);
    if (stableEventId !== undefined) {
        return `graph:${turnId}:event:${encodeURIComponent(stableEventId)}`;
    }
    state.graphOccurrenceOrdinal += 1;
    return `graph:${turnId}:occurrence:${state.graphOccurrenceOrdinal}`;
}

export function createGraphTurnPrefix(executionTurnId: string, startEventId: string): string {
    return `graph:${encodeURIComponent(executionTurnId)}:${encodeURIComponent(startEventId)}`;
}

export function graphTurnPartId(prefix: string, lane: GraphTurnLane): string {
    return `${prefix}:${lane}`;
}

export function openGraphTurn(state: ProviderRenderState, nodeId: string, startEventId: string): string {
    const prefix = createGraphTurnPrefix(state.executionTurnId, startEventId);
    state.openGraphTurnByNode.set(nodeId, prefix);
    const pending = state.terminalGraphTurnsByNode.get(nodeId);
    if (pending === undefined) {
        state.terminalGraphTurnsByNode.set(nodeId, [prefix]);
    } else {
        pending.push(prefix);
    }
    return prefix;
}

export function currentGraphTurnPrefix(state: ProviderRenderState, nodeId: string): string | undefined {
    return state.openGraphTurnByNode.get(nodeId);
}

export function nextGraphTerminalTurnPrefix(state: ProviderRenderState, nodeId: string): string | undefined {
    return state.terminalGraphTurnsByNode.get(nodeId)?.[0];
}

export function settleGraphTerminalTurn(state: ProviderRenderState, nodeId: string, expectedPrefix: string): boolean {
    const pending = state.terminalGraphTurnsByNode.get(nodeId);
    if (pending?.[0] !== expectedPrefix) return false;
    pending.shift();
    if (pending.length === 0) state.terminalGraphTurnsByNode.delete(nodeId);
    if (state.openGraphTurnByNode.get(nodeId) === expectedPrefix) state.openGraphTurnByNode.delete(nodeId);
    state.toolSummaryByGraphTurn.delete(expectedPrefix);
    return true;
}

export function recordGraphTurnTool(state: ProviderRenderState, nodeId: string, toolName: string): string | undefined {
    const prefix = nextGraphTerminalTurnPrefix(state, nodeId);
    if (prefix === undefined) return undefined;
    const previous = state.toolSummaryByGraphTurn.get(prefix);
    state.toolSummaryByGraphTurn.set(prefix, {
        count: (previous?.count ?? 0) + 1,
        names: [...(previous?.names ?? []), toolName],
    });
    return prefix;
}

export function graphTurnToolSummary(state: ProviderRenderState, prefix: string): GraphTurnToolSummary | undefined {
    return state.toolSummaryByGraphTurn.get(prefix);
}

export function recordGraphErrorEmission(state: ProviderRenderState, emission: GraphErrorEmissionState): void {
    state.lastGraphErrorEmission = emission;
}
