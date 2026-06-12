import {
    appendProviderToolResultMessages,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT,
    type ProviderAdapter,
    ProviderTurnError,
    ProviderTurnRunner,
    providerToolLoopLimitError,
    type ToolInvocationSettlement,
    toolCallsFromProviderEnvelopes,
} from '@mission-control/core';
import type { AgentEvent, AgentMessage, ModelProviderSelection } from '@mission-control/protocol';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { createInteractiveToolRegistry, settleInteractiveToolCall } from './interactive-coding-tools.js';

export type ActiveCodingAgentTurn = {
    readonly done: Promise<void>;
    readonly interrupt: (mode?: InterruptMode) => void;
    readonly answerApproval: (line: string) => boolean;
    readonly hasPendingApproval: () => boolean;
};

export type InterruptMode = 'soft' | 'force';

export type CodingAgentTurnOptions = {
    readonly prompt: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export async function startCodingAgentTurn(options: CodingAgentTurnOptions): Promise<ActiveCodingAgentTurn> {
    const controller = new AbortController();
    const approvals = createInteractiveApprovalBroker(options);
    const registry = await createInteractiveToolRegistry(options, approvals);
    const state: TurnState = { phase: 'provider' };
    const done = runCodingAgentTurn(options, controller.signal, approvals, registry, state).finally(() => {
        state.phase = 'settled';
    });

    return {
        done,
        interrupt: (mode = 'force') => {
            if (mode === 'force' || state.phase === 'provider') {
                controller.abort();
            }
            approvals.cancel('interrupted by user');
        },
        answerApproval: approvals.answer,
        hasPendingApproval: approvals.hasPending,
    };
}

async function runCodingAgentTurn(
    options: CodingAgentTurnOptions,
    signal: AbortSignal,
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
    registry: Awaited<ReturnType<typeof createInteractiveToolRegistry>>,
    state: TurnState,
): Promise<void> {
    emitTaskEvent(options, 'task.started', `user prompt: ${options.prompt}`);
    emitRunEvent(options, 'run.started', 'run started');

    let messages: readonly AgentMessage[] = [{ role: 'user', content: options.prompt }];
    let toolContinuationTurns = 0;

    while (!signal.aborted) {
        state.phase = 'provider';
        let streamedText = false;
        const runner = new ProviderTurnRunner({ provider: options.provider });
        const result = await runner.runTurn({
            sessionId: options.sessionId,
            turnId: providerTurnId(options.turnId, toolContinuationTurns),
            requestId: providerRequestId(options.turnId, toolContinuationTurns),
            providerID: options.modelProviderSelection.providerID,
            modelID: options.modelProviderSelection.modelID,
            ...(options.modelProviderSelection.variantID !== undefined
                ? { variantID: options.modelProviderSelection.variantID }
                : {}),
            messages,
            tools: registry.advertise().map((tool) => tool.providerTool),
            startSequence: 0,
            signal,
            onEnvelope: (envelope) => {
                const chunk = envelope.event.providerStreamChunk;
                if (chunk?.kind === 'text_delta') {
                    if (!streamedText) {
                        options.output.write('Assistant: ');
                        streamedText = true;
                    }
                    options.output.write(chunk.delta);
                }
                if (envelope.durability === 'durable') {
                    options.emitEvent(envelope.event);
                }
            },
        });

        if (streamedText) {
            options.output.write('\n');
        }
        if (result.status === 'failed') {
            if (result.error.code === 'provider_aborted') {
                emitInterrupted(options, 'provider turn interrupted');
                return;
            }
            emitTaskEvent(options, 'task.failed', result.error.message);
            throw new ProviderTurnError(result.error);
        }

        const toolCalls = toolCallsFromProviderEnvelopes(result.envelopes);
        if (toolCalls.length === 0) {
            if (!streamedText) {
                options.output.write(`Assistant: ${result.message.content}\n`);
            }
            emitTaskEvent(options, 'task.completed', result.message.content);
            emitRunEvent(options, 'run.completed', 'run completed');
            return;
        }
        if (toolContinuationTurns >= DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT) {
            const error = providerToolLoopLimitError(DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT);
            emitTaskEvent(options, 'task.failed', error.message);
            throw new ProviderTurnError(error);
        }

        state.phase = 'tools';
        const settlements: ToolInvocationSettlement[] = [];
        for (const toolCall of toolCalls) {
            if (signal.aborted) {
                emitInterrupted(options, 'tool execution interrupted');
                return;
            }
            if (approvals.hasPending()) {
                emitBlocked(options, 'tool approval already pending');
                return;
            }
            const settlement = await settleInteractiveToolCall(registry, toolCall, options, approvals, signal);
            if (settlement === undefined) {
                emitBlocked(options, `tool not settled: ${toolCall.toolName}`);
                return;
            }
            settlements.push(settlement);
            if (signal.aborted) {
                emitInterrupted(options, 'tool execution interrupted');
                return;
            }
        }

        messages = appendProviderToolResultMessages({
            messages,
            assistantMessage: result.message,
            settlements,
        });
        toolContinuationTurns += 1;
    }

    emitInterrupted(options, 'provider turn interrupted');
}

type TurnState = {
    phase: 'provider' | 'tools' | 'settled';
};

function emitInterrupted(options: CodingAgentTurnOptions, message: string): void {
    options.output.write('Interrupted active run\n');
    emitRunEvent(options, 'run.interrupted', 'run interrupted');
    emitTaskEvent(options, 'task.failed', message);
}

function emitBlocked(options: CodingAgentTurnOptions, message: string): void {
    options.output.write(`Run blocked: ${message}\n`);
    emitRunEvent(options, 'run.interrupted', `run blocked: ${message}`);
    emitTaskEvent(options, 'task.failed', message);
}

function emitTaskEvent(
    options: CodingAgentTurnOptions,
    type: 'task.started' | 'task.completed' | 'task.failed',
    message: string,
): void {
    options.emitEvent({
        type,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        taskId: options.turnId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: options.modelProviderSelection,
    });
}

function emitRunEvent(
    options: CodingAgentTurnOptions,
    type: 'run.started' | 'run.completed' | 'run.interrupted',
    message: string,
): void {
    options.emitEvent({
        type,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message,
        run: {
            command: 'run',
            state: type === 'run.interrupted' ? 'interrupted' : type === 'run.started' ? 'running' : 'completed',
            runId: `run_${options.turnId}`,
        },
        modelProviderSelection: options.modelProviderSelection,
    });
}

function providerTurnId(baseTurnId: string, continuationTurns: number): string {
    return continuationTurns === 0 ? baseTurnId : `${baseTurnId}_continue_${continuationTurns}`;
}

function providerRequestId(baseTurnId: string, continuationTurns: number): string {
    return `provider_request_${providerTurnId(baseTurnId, continuationTurns)}`;
}
