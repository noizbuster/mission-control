import type { AgentEvent, AgentMessage, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
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

export type RunCoordinatorProviderTurnResult = {
    readonly status: 'completed' | 'interrupted';
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
            return { status: 'completed' };
        }

        const toolCalls = toolCallsFromProviderEnvelopes(result.envelopes);
        if (toolCalls.length === 0 || input.toolRegistry === undefined) {
            return { status: 'completed' };
        }
        const loopLimit = input.toolCallLoopLimit ?? DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT;
        if (toolContinuationTurns >= loopLimit) {
            throw new ProviderTurnError(providerToolLoopLimitError(loopLimit));
        }
        messages = appendProviderToolResultMessages({
            messages,
            assistantMessage: result.message,
            settlements: await settleToolCalls(input, toolCalls, signal),
        });
        toolContinuationTurns += 1;
    }
    return { status: 'interrupted' };
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
