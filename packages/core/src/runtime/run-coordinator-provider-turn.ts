import type {
    AgentEvent,
    AgentMessage,
    ModelProviderSelection,
    ProtocolErrorCode,
    ToolCall,
} from '@mission-control/protocol';
import {
    appendProviderToolResultMessages,
    DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT,
    providerToolLoopLimitError,
    sessionScopedToolEvent,
    settleToolCallWithRegistry,
    toolCallsFromProviderEnvelopes,
} from '../provider-tool-continuation.js';
import { ProviderTurnRunner } from '../providers/provider-turn-runner.js';
import { type ProviderAdapter, ProviderTurnError } from '../providers/provider-turn-types.js';
import type { ToolInvocationSettlement, ToolRegistry } from '../tools/tool-registry.js';
import type { RunCoordinatorProviderTurnResult } from './run-coordinator-lifecycle.js';
import { providerRunnerOptions } from './run-coordinator-provider-options.js';
import { providerTurnSelection } from './run-coordinator-provider-selection.js';

export type RunCoordinatorProviderTurnInput = {
    readonly sessionId: string;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly readMessages: () => Promise<readonly AgentMessage[]>;
    readonly nextId: (prefix: string) => Promise<string>;
    readonly appendDurableEvent: (event: AgentEvent) => Promise<void>;
};

export async function runCoordinatorProviderTurn(
    input: RunCoordinatorProviderTurnInput,
    signal: AbortSignal,
): Promise<RunCoordinatorProviderTurnResult> {
    let messages = await input.readMessages();
    let toolContinuationTurns = 0;

    while (!signal.aborted) {
        const runner = new ProviderTurnRunner({
            provider: input.provider,
            ...providerRunnerOptions(input),
        });
        const result = await runner.runTurn({
            sessionId: input.sessionId,
            turnId: await input.nextId('turn'),
            requestId: await input.nextId('request'),
            ...providerTurnSelection(input.modelProviderSelection),
            messages,
            ...(input.toolRegistry !== undefined
                ? { tools: input.toolRegistry.advertise().map((tool) => tool.providerTool) }
                : {}),
            startSequence: 0,
            signal,
            writeEnvelope: async (envelope) => {
                if (envelope.durability === 'durable') {
                    await input.appendDurableEvent(envelope.event);
                }
            },
        });
        if (result.status === 'failed' && result.error.code === 'provider_aborted') {
            return { status: 'interrupted' };
        }
        if (result.status === 'failed') {
            return {
                status: 'failed',
                reason: result.error.message,
                errorCode: result.error.code,
            };
        }

        const toolCalls = toolCallsFromProviderEnvelopes(result.envelopes);
        const firstToolCall = toolCalls.at(0);
        if (firstToolCall === undefined) {
            return { status: 'completed' };
        }
        if (input.toolRegistry === undefined) {
            return approvalBlockedResult(firstToolCall);
        }
        const loopLimit = input.toolCallLoopLimit ?? DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT;
        if (toolContinuationTurns >= loopLimit) {
            throw new ProviderTurnError(providerToolLoopLimitError(loopLimit));
        }
        const settlements = await settleToolCalls(input, toolCalls, signal);
        const blockedSettlement = approvalRequiredSettlement(settlements);
        if (blockedSettlement !== undefined) {
            return {
                status: 'blocked_on_approval',
                reason: blockedSettlement.reason,
                errorCode: blockedSettlement.errorCode,
                toolCallId: blockedSettlement.toolCallId,
            };
        }
        messages = appendProviderToolResultMessages({
            messages,
            assistantMessage: result.message,
            settlements,
        });
        toolContinuationTurns += 1;
    }
    return { status: 'interrupted' };
}

function approvalBlockedResult(toolCall: ToolCall): RunCoordinatorProviderTurnResult {
    return {
        status: 'blocked_on_approval',
        reason: `waiting for approval: ${toolCall.toolName}`,
        errorCode: 'tool_failed',
        toolCallId: toolCall.toolCallId,
    };
}

type ApprovalRequiredSettlement = {
    readonly toolCallId: string;
    readonly reason: string;
    readonly errorCode: ProtocolErrorCode;
};

function approvalRequiredSettlement(
    settlements: readonly ToolInvocationSettlement[],
): ApprovalRequiredSettlement | undefined {
    for (const settlement of settlements) {
        const error = settlement.result.error;
        if (error?.message.startsWith('approval_required:') === true) {
            return {
                toolCallId: settlement.toolCallId,
                reason: error.message,
                errorCode: error.code,
            };
        }
    }
    return undefined;
}

async function settleToolCalls(
    input: RunCoordinatorProviderTurnInput,
    toolCalls: readonly ToolCall[],
    signal: AbortSignal,
): Promise<readonly ToolInvocationSettlement[]> {
    const registry = input.toolRegistry;
    if (registry === undefined) {
        return [];
    }
    const settlements: ToolInvocationSettlement[] = [];
    for (const toolCall of toolCalls) {
        const settlement = await settleToolCallWithRegistry(registry, toolCall, signal);
        settlements.push(settlement);
        for (const event of settlement.events) {
            await input.appendDurableEvent(
                sessionScopedToolEvent(event, input.sessionId, input.modelProviderSelection),
            );
        }
    }
    return settlements;
}
