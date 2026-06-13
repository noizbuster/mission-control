import type {
    AgentEvent,
    AgentEventEnvelope,
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
import type {
    RunCoordinatorEnvelopeObserver,
    RunCoordinatorToolCallObserver,
    RunCoordinatorToolSettlementObserver,
} from './run-coordinator-types.js';

export type RunCoordinatorProviderTurnInput = {
    readonly sessionId: string;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly haltOnFailedToolSettlement?: boolean;
    readonly toolRegistry?: ToolRegistry;
    readonly readMessages: () => Promise<readonly AgentMessage[]>;
    readonly nextId: (prefix: string) => Promise<string>;
    readonly appendDurableEvent: (event: AgentEvent) => Promise<void>;
    readonly appendDurableEnvelope: (envelope: AgentEventEnvelope) => Promise<void>;
    readonly onProviderEnvelope?: RunCoordinatorEnvelopeObserver;
    readonly onToolCall?: RunCoordinatorToolCallObserver;
    readonly onToolSettlement?: RunCoordinatorToolSettlementObserver;
};

export async function runCoordinatorProviderTurn(
    input: RunCoordinatorProviderTurnInput,
    signal: AbortSignal,
): Promise<RunCoordinatorProviderTurnResult> {
    let messages = await input.readMessages();
    let toolContinuationTurns = 0;

    while (!signal.aborted) {
        const turnId = await input.nextId('turn');
        const requestId = await input.nextId('request');
        const runner = new ProviderTurnRunner({
            provider: input.provider,
            ...providerRunnerOptions(input),
            createEventId: (_event, sequence) => `${requestId}_provider_event_${sequence}`,
        });
        const result = await runner.runTurn({
            sessionId: input.sessionId,
            turnId,
            requestId,
            ...providerTurnSelection(input.modelProviderSelection),
            messages,
            ...(input.toolRegistry !== undefined
                ? { tools: input.toolRegistry.advertise().map((tool) => tool.providerTool) }
                : {}),
            startSequence: 0,
            ...(input.onProviderEnvelope !== undefined ? { onEnvelope: input.onProviderEnvelope } : {}),
            signal,
            writeEnvelope: async (envelope) => {
                if (envelope.durability === 'durable') {
                    await input.appendDurableEnvelope(envelope);
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
        const blockedSettlement = approvalBlockedSettlement(settlements);
        if (blockedSettlement !== undefined) {
            return {
                status: 'blocked_on_approval',
                reason: blockedSettlement.reason,
                errorCode: blockedSettlement.errorCode,
                toolCallId: blockedSettlement.toolCallId,
            };
        }
        if (input.haltOnFailedToolSettlement === true) {
            const terminalFailure = terminalFailedSettlement(settlements);
            if (terminalFailure !== undefined) {
                return terminalFailure;
            }
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

function approvalBlockedSettlement(
    settlements: readonly ToolInvocationSettlement[],
): ApprovalRequiredSettlement | undefined {
    for (const settlement of settlements) {
        const error = settlement.result.error;
        if (error !== undefined && isApprovalBlockedMessage(error.message)) {
            return {
                toolCallId: settlement.toolCallId,
                reason: error.message,
                errorCode: error.code,
            };
        }
    }
    return undefined;
}

function isApprovalBlockedMessage(message: string | undefined): boolean {
    return message?.startsWith('approval_required:') === true || message?.startsWith('approval_denied:') === true;
}

function terminalFailedSettlement(
    settlements: readonly ToolInvocationSettlement[],
): RunCoordinatorProviderTurnResult | undefined {
    for (const settlement of settlements) {
        if (settlement.result.status !== 'failed') {
            continue;
        }
        const error = settlement.result.error;
        if (error === undefined) {
            continue;
        }
        if (error.message.startsWith('approval_required:')) {
            return {
                status: 'blocked_on_approval',
                reason: error.message,
                errorCode: error.code,
                toolCallId: settlement.toolCallId,
            };
        }
        return {
            status: 'failed',
            reason: error.message,
            errorCode: error.code,
        };
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
        const preflightSettlement = await input.onToolCall?.(toolCall);
        const settlement = preflightSettlement ?? (await settleToolCallWithRegistry(registry, toolCall, signal));
        await input.onToolSettlement?.(settlement);
        settlements.push(settlement);
        for (const event of settlement.events) {
            await input.appendDurableEvent(
                sessionScopedToolEvent(event, input.sessionId, input.modelProviderSelection),
            );
        }
        if (approvalBlockedSettlement([settlement]) !== undefined) {
            break;
        }
    }
    return settlements;
}
