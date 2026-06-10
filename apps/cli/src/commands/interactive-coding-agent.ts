import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type ProviderAdapter,
    ProviderTurnRunner,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
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
    const toolCalls: ToolCall[] = [];
    let streamedText = false;
    emitTaskEvent(options, 'task.started', `user prompt: ${options.prompt}`);
    emitRunEvent(options, 'run.started', 'run started');

    const runner = new ProviderTurnRunner({ provider: options.provider });
    const result = await runner.runTurn({
        sessionId: options.sessionId,
        turnId: options.turnId,
        requestId: `provider_request_${options.turnId}`,
        providerID: options.modelProviderSelection.providerID,
        modelID: options.modelProviderSelection.modelID,
        ...(options.modelProviderSelection.variantID !== undefined
            ? { variantID: options.modelProviderSelection.variantID }
            : {}),
        messages: [{ role: 'user', content: options.prompt }],
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
            if (chunk?.kind === 'tool_call_completed') {
                toolCalls.push(chunk.toolCall);
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
        throw new Error(result.error.message);
    }
    if (!streamedText) {
        options.output.write(`Assistant: ${result.message.content}\n`);
    }

    state.phase = 'tools';
    for (const toolCall of toolCalls) {
        if (signal.aborted) {
            emitInterrupted(options, 'tool execution interrupted');
            return;
        }
        if (approvals.hasPending()) {
            break;
        }
        await settleInteractiveToolCall(registry, toolCall, options, approvals, signal);
        if (signal.aborted) {
            emitInterrupted(options, 'tool execution interrupted');
            return;
        }
    }

    emitTaskEvent(options, 'task.completed', result.message.content);
    emitRunEvent(options, 'run.completed', 'run completed');
}

type TurnState = {
    phase: 'provider' | 'tools' | 'settled';
};

function emitInterrupted(options: CodingAgentTurnOptions, message: string): void {
    options.output.write('Interrupted active run\n');
    emitRunEvent(options, 'run.interrupted', 'run interrupted');
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
