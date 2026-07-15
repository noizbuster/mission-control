import { redactCredentialText, type ToolInvocationSettlement } from '@mission-control/core';
import type { AbgGraphSpec, AbgSignal, AgentEvent, AgentEventEnvelope, ToolCall } from '@mission-control/protocol';
import {
    type AbgOverlayController,
    type AbgOverlayState,
    projectAbgSignal,
    RECENT_EVENTS_CAP,
    type RecentEvent,
    type RunState,
    readRefreshMsFromEnv,
} from '@mission-control/tui/state';

export type AbgOverlayWiring = {
    readonly observer: (signal: AbgSignal) => void;
    readonly onDurableEvent: (event: AgentEvent) => void;
    readonly onProviderEnvelope?: (envelope: AgentEventEnvelope) => void;
    readonly onToolCall?: (toolCall: ToolCall) => void;
    readonly onToolSettlement?: (settlement: ToolInvocationSettlement) => void;
    readonly dispose: () => void;
};

export function wireAbgOverlay(controller: AbgOverlayController, graphSpec?: AbgGraphSpec): AbgOverlayWiring {
    const store = controller.store;
    let pendingSnapshot: AbgOverlayState = store.getSnapshot();
    let pending: Partial<AbgOverlayState> = {};
    let dirty = false;
    const commitToStore = (): void => {
        if (!dirty) return;
        const patch = pending;
        pending = {};
        dirty = false;
        store.update((draft) => Object.assign(draft, patch));
        pendingSnapshot = store.getSnapshot();
    };
    const timer = setInterval(() => {
        clearStalePerformanceEntries();
        commitToStore();
    }, readRefreshMsFromEnv());

    if (graphSpec !== undefined) {
        const nodes = new Map(pendingSnapshot.nodes);
        for (const node of graphSpec.nodes) if (!nodes.has(node.id)) nodes.set(node.id, 'idle');
        pending = {
            ...pending,
            activeGraphId: graphSpec.id,
            graphStatus: 'active',
            nodes,
            graphEdges: graphSpec.edges.map((edge) => ({
                source: edge.source,
                target: edge.target,
                ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
            })),
        };
        pendingSnapshot = { ...pendingSnapshot, ...pending };
        dirty = true;
        commitToStore();
    }

    const observer = (signal: AbgSignal): void => {
        const patch = projectAbgSignal(pendingSnapshot, signal);
        pendingSnapshot = { ...pendingSnapshot, ...patch };
        pending = { ...pending, ...patch };
        dirty = true;
    };

    const onDurableEvent = (event: AgentEvent): void => {
        const abg = event.abg;
        if (abg !== undefined) {
            if (abg.graphId !== undefined && event.type === 'graph.started') {
                const nodes = new Map(pendingSnapshot.nodes);
                if (graphSpec !== undefined) {
                    for (const node of graphSpec.nodes) if (!nodes.has(node.id)) nodes.set(node.id, 'idle');
                }
                pending = { ...pending, activeGraphId: abg.graphId, graphStatus: 'active', nodes };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.graphId !== undefined && event.type === 'graph.completed') {
                pending = { ...pending, graphStatus: 'completed' };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.graphId !== undefined && event.type === 'graph.failed') {
                pending = { ...pending, graphStatus: 'failed' };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.nodeId !== undefined) {
                const nodes = new Map(pendingSnapshot.nodes);
                if (event.type === 'node.started') nodes.set(abg.nodeId, 'running');
                else if (event.type === 'node.completed') nodes.set(abg.nodeId, 'succeeded');
                else if (event.type === 'node.failed') nodes.set(abg.nodeId, 'failed');
                pending = { ...pending, nodes };
                pendingSnapshot = { ...pendingSnapshot, nodes };
                dirty = true;
            }
        }
        commitToStore();
        const settleState = runSettleState(event.type);
        if (settleState === undefined) return;
        const pendingApprovals = approvalPatchForEvent(event, settleState);
        store.update((draft) => {
            Object.assign(draft, {
                runState: settleState,
                lastSettledAt: event.timestamp,
                ...(event.type === 'run.interrupted' ? { graphStatus: 'cancelled' } : {}),
                ...(pendingApprovals !== undefined ? { pendingApprovals } : {}),
            });
        });
    };

    const onProviderEnvelope = (envelope: AgentEventEnvelope): void => {
        const patch = applyProviderEnvelopeToPatch(pendingSnapshot, envelope);
        if (Object.keys(patch).length === 0) return;
        pendingSnapshot = { ...pendingSnapshot, ...patch };
        pending = { ...pending, ...patch };
        dirty = true;
    };
    const onToolCall = (toolCall: ToolCall): void => {
        const event: RecentEvent = {
            timestamp: '',
            type: 'tool.started',
            message: redactCredentialText(`tool call: ${toolCall.toolName}`, []),
        };
        pendingSnapshot = { ...pendingSnapshot, recentEvents: [event] };
        pending = { ...pending, recentEvents: [event] };
        dirty = true;
    };
    const onToolSettlement = (settlement: ToolInvocationSettlement): void => {
        const event: RecentEvent = {
            timestamp: '',
            type: settlement.result.status === 'completed' ? 'tool.completed' : 'tool.failed',
            message: redactCredentialText(`tool ${settlement.toolName}: ${settlement.result.status}`, []),
        };
        pendingSnapshot = {
            ...pendingSnapshot,
            recentEvents: [...pendingSnapshot.recentEvents, event].slice(-RECENT_EVENTS_CAP),
        };
        pending = { ...pending, recentEvents: [...(pending.recentEvents ?? []), event] };
        dirty = true;
    };
    const dispose = (): void => {
        clearInterval(timer);
        commitToStore();
    };
    return { observer, onDurableEvent, onProviderEnvelope, onToolCall, onToolSettlement, dispose };
}

type PendingApproval = AbgOverlayState['pendingApprovals'][number];

function approvalPatchForEvent(event: AgentEvent, settleState: RunState): readonly PendingApproval[] | undefined {
    if (event.type !== 'run.blocked') {
        return settleState === 'running' || settleState === 'completed' || settleState === 'failed' ? [] : undefined;
    }
    const directToolCallId = Reflect.get(event, 'toolCallId');
    const directApprovalId = Reflect.get(event, 'approvalId');
    const toolCallId = typeof directToolCallId === 'string' ? directToolCallId : event.run?.toolCallId;
    if (toolCallId === undefined) return undefined;
    const reason = event.run?.reason ?? event.message;
    return [
        {
            approvalId: typeof directApprovalId === 'string' ? directApprovalId : toolCallId,
            requestId: toolCallId,
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: { kind: 'tool', id: toolCallId },
            requestedAt: event.timestamp,
            ...(reason !== undefined ? { reason } : {}),
        },
    ];
}

function runSettleState(eventType: string): RunState | undefined {
    if (eventType === 'run.completed') return 'completed';
    if (eventType === 'run.interrupted') return 'interrupted';
    if (eventType === 'run.failed') return 'failed';
    if (eventType === 'run.blocked') return 'blocked_on_approval';
    return undefined;
}

function applyProviderEnvelopeToPatch(state: AbgOverlayState, envelope: AgentEventEnvelope): Partial<AbgOverlayState> {
    const chunk = envelope.event.providerStreamChunk;
    if (chunk?.kind === 'text_delta') return { lastLiveDelta: redactCredentialText(chunk.delta, []) };
    if (chunk?.kind === 'response_completed' && chunk.usage !== undefined) {
        return {
            inputTokens: state.inputTokens + chunk.usage.inputTokens,
            outputTokens: state.outputTokens + chunk.usage.outputTokens,
            modelCalls: state.modelCalls + 1,
        };
    }
    return {};
}

function clearStalePerformanceEntries(): void {
    const performance = globalThis.performance;
    if (performance === undefined || typeof performance.clearMeasures !== 'function') return;
    if (performance.getEntriesByType('measure').length < 10_000) return;
    performance.clearMeasures();
    performance.clearMarks?.();
}
