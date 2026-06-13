import type { AgentEvent, ApprovalRecord, ToolCall } from '../packages/protocol/src/index.js';
import {
    approvalIdForToolCall,
    codingAgentSmokeSelection,
    createSmokeApprovalEventId,
    fixedCodingAgentSmokeNow,
    requestIdForToolCall,
    type SmokeApprovalDependencies,
    type SmokeApprovalStore,
} from './coding-agent-smoke-shared.ts';

export async function approvePendingSmokePatch(
    input: {
        readonly dataDir: string;
        readonly sessionId: string;
        readonly workspaceRoot: string;
        readonly toolCallId: string;
    },
    dependencies: SmokeApprovalDependencies,
): Promise<void> {
    const store = await dependencies.openStore({
        dataDir: input.dataDir,
        sessionId: input.sessionId,
        now: fixedCodingAgentSmokeNow,
        createEventId: createSmokeApprovalEventId,
    });
    try {
        await ensureSmokePendingApproval(store, input.sessionId, input.toolCallId);
        const status = await dependencies.settleApproval(
            {
                sessionId: input.sessionId,
                approvalId: approvalIdForToolCall(input.toolCallId),
                state: 'approved',
                reason: 'approved for smoke resume',
            },
            {
                store,
                sessionId: input.sessionId,
                workspaceRoot: input.workspaceRoot,
                modelProviderSelection: codingAgentSmokeSelection,
                now: fixedCodingAgentSmokeNow,
            },
        );
        if (status !== 'completed') {
            throw new Error(`expected completed approval settlement, received ${status}`);
        }
    } finally {
        await store.close();
    }
}

async function ensureSmokePendingApproval(
    store: SmokeApprovalStore,
    sessionId: string,
    toolCallId: string,
): Promise<void> {
    const approvalId = approvalIdForToolCall(toolCallId);
    const requestId = requestIdForToolCall(toolCallId);
    const events = await store.getEvents(sessionId);
    const toolCall = toolCallForId(events, toolCallId);
    if (toolCall === undefined) {
        throw new Error(`missing tool call for ${approvalId}`);
    }
    const latestRunState = latestRunStateEvent(events);
    if (
        latestRunState?.type !== 'run.blocked' ||
        latestRunState.run?.state !== 'blocked_on_approval' ||
        latestRunState.run.toolCallId !== toolCallId
    ) {
        throw new Error(`current blocked run does not target ${toolCallId}`);
    }
    if (!hasPermissionRequested(events, requestId)) {
        throw new Error(`missing runtime-owned permission.requested for ${requestId}`);
    }
    if (!hasRequestedApproval(events, approvalId, requestId)) {
        throw new Error(`missing runtime-owned approval.requested for ${approvalId}`);
    }
    if (latestApprovalState(events, approvalId) === 'pending') {
        return;
    }
    await store.append(
        approvalRequestedEvent(
            sessionId,
            toolCall,
            `approval requested: ${toolCall.toolName}`,
            fixedCodingAgentSmokeNow,
        ),
    );
}

function toolCallForId(events: readonly AgentEvent[], toolCallId: string): ToolCall | undefined {
    return [...events]
        .reverse()
        .flatMap((event) => {
            const chunk = event.providerStreamChunk;
            return chunk?.kind === 'tool_call_completed' ? [chunk.toolCall] : [];
        })
        .find((toolCall) => toolCall.toolCallId === toolCallId);
}

function latestRunStateEvent(events: readonly AgentEvent[]): AgentEvent | undefined {
    return [...events].reverse().find((event) => event.run?.state !== undefined && isRunStateEvent(event.type));
}

function hasPermissionRequested(events: readonly AgentEvent[], requestId: string): boolean {
    return events.some((event) => {
        if (event.type !== 'permission.requested') {
            return false;
        }
        return event.permissionRequest?.id === requestId || event.permissionDecision?.requestId === requestId;
    });
}

function hasRequestedApproval(events: readonly AgentEvent[], approvalId: string, requestId: string): boolean {
    return events.some(
        (event) =>
            event.type === 'approval.requested' &&
            event.approvalRecord?.approvalId === approvalId &&
            event.approvalRecord.requestId === requestId,
    );
}

function latestApprovalState(events: readonly AgentEvent[], approvalId: string): ApprovalRecord['state'] | undefined {
    return [...events].reverse().find((event) => event.approvalRecord?.approvalId === approvalId)?.approvalRecord
        ?.state;
}

function approvalRequestedEvent(sessionId: string, toolCall: ToolCall, message: string, now: () => string): AgentEvent {
    return {
        type: 'approval.requested',
        timestamp: now(),
        sessionId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: codingAgentSmokeSelection,
        approvalRecord: {
            approvalId: approvalIdForToolCall(toolCall.toolCallId),
            requestId: requestIdForToolCall(toolCall.toolCallId),
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: { kind: 'tool', id: toolCall.toolName },
            requestedAt: now(),
            reason: `approve ${toolCall.toolName}`,
        },
    };
}

function isRunStateEvent(type: AgentEvent['type']): boolean {
    switch (type) {
        case 'run.started':
        case 'run.completed':
        case 'run.interrupted':
        case 'run.failed':
        case 'run.blocked':
        case 'run.idle':
            return true;
        default:
            return false;
    }
}
