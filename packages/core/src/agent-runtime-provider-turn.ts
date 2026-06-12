import type {
    AgentEventEnvelope,
    AgentMessage,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ToolCall,
} from '@mission-control/protocol';
import {
    appendProviderToolResultMessages,
    DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT,
    providerToolLoopLimitError,
    sessionScopedToolEvent,
    settleToolCallWithRegistry,
    toolCallsFromProviderEnvelopes,
} from './provider-tool-continuation.js';
import { ProviderTurnRunner } from './providers/provider-turn-runner.js';
import { type ProviderAdapter, ProviderTurnError } from './providers/provider-turn-types.js';
import type { ToolInvocationSettlement, ToolRegistry } from './tools/tool-registry.js';

export type RuntimeProviderPromptInput = {
    readonly provider: ProviderAdapter;
    readonly sessionId: string;
    readonly taskId: string;
    readonly prompt: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly providerTimeoutMs?: number;
    readonly providerRetryLimit?: number;
    readonly providerTurnLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly onEnvelope: (envelope: AgentEventEnvelope) => void;
};

export async function runRuntimeProviderPromptTask(input: RuntimeProviderPromptInput): Promise<string> {
    let messages: readonly AgentMessage[] = [{ role: 'user', content: input.prompt }];
    let toolContinuationTurns = 0;

    while (true) {
        const runner = new ProviderTurnRunner({
            provider: input.provider,
            ...(input.providerTimeoutMs !== undefined ? { timeoutMs: input.providerTimeoutMs } : {}),
            ...(input.providerRetryLimit !== undefined ? { retryLimit: input.providerRetryLimit } : {}),
            ...(input.providerTurnLoopLimit !== undefined ? { toolCallLoopLimit: input.providerTurnLoopLimit } : {}),
        });
        const result = await runner.runTurn({
            sessionId: input.sessionId,
            turnId: providerTurnId(input.taskId, toolContinuationTurns),
            requestId: providerRequestId(input.taskId, toolContinuationTurns),
            providerID: input.modelProviderSelection.providerID,
            modelID: input.modelProviderSelection.modelID,
            ...(input.modelProviderSelection.variantID !== undefined
                ? { variantID: input.modelProviderSelection.variantID }
                : {}),
            messages,
            ...(input.toolRegistry !== undefined
                ? { tools: input.toolRegistry.advertise().map((tool) => tool.providerTool) }
                : {}),
            startSequence: 0,
            onEnvelope: input.onEnvelope,
        });
        if (result.status === 'failed') {
            throw new ProviderTurnError(result.error);
        }

        const toolCalls = toolCallsFromProviderEnvelopes(result.envelopes);
        if (toolCalls.length === 0) {
            return result.message.content;
        }
        if (input.toolRegistry === undefined) {
            await requireProviderToolPermissions(input, result.envelopes);
            return result.message.content;
        }
        const loopLimit = input.providerTurnLoopLimit ?? DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT;
        if (toolContinuationTurns >= loopLimit) {
            throw new ProviderTurnError(providerToolLoopLimitError(loopLimit));
        }
        messages = appendProviderToolResultMessages({
            messages,
            assistantMessage: result.message,
            settlements: await settleRuntimeToolCalls(input, toolCalls),
        });
        toolContinuationTurns += 1;
    }
}

async function requireProviderToolPermissions(
    input: RuntimeProviderPromptInput,
    envelopes: readonly AgentEventEnvelope[],
): Promise<void> {
    for (const envelope of envelopes) {
        const chunk = envelope.event.providerStreamChunk;
        if (chunk?.kind !== 'tool_call_completed') {
            continue;
        }
        await input.requestPermission({
            id: `permission_${chunk.toolCall.toolCallId}`,
            action: chunk.toolCall.toolName,
            reason: `provider requested tool: ${chunk.toolCall.toolName}`,
        });
    }
}

async function settleRuntimeToolCalls(
    input: RuntimeProviderPromptInput,
    toolCalls: readonly ToolCall[],
): Promise<readonly ToolInvocationSettlement[]> {
    const registry = input.toolRegistry;
    if (registry === undefined) {
        return [];
    }
    const settlements: ToolInvocationSettlement[] = [];
    for (const toolCall of toolCalls) {
        const settlement = await settleToolCallWithRegistry(registry, toolCall, new AbortController().signal);
        settlements.push(settlement);
        for (const event of settlement.events) {
            input.onEnvelope({
                eventId: `tool_event_${toolCall.toolCallId}_${event.type}`,
                sequence: 0,
                createdAt: event.timestamp,
                sessionId: input.sessionId,
                durability: 'durable',
                event: sessionScopedToolEvent(event, input.sessionId, input.modelProviderSelection),
            });
        }
    }
    return settlements;
}

function providerTurnId(baseTaskId: string, continuationTurns: number): string {
    return continuationTurns === 0 ? baseTaskId : `${baseTaskId}_continue_${continuationTurns}`;
}

function providerRequestId(baseTaskId: string, continuationTurns: number): string {
    return `provider_request_${providerTurnId(baseTaskId, continuationTurns)}`;
}
