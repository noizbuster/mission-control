import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type JsonlSessionEventStore,
    type ProviderAdapter,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type ToolInvocationSettlement,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { parseFilePatchOutput, renderToolPreview } from './interactive-coding-tool-preview.js';
import { createInteractiveToolRegistry } from './interactive-coding-tools.js';

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
    readonly store: JsonlSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export async function startCodingAgentTurn(options: CodingAgentTurnOptions): Promise<ActiveCodingAgentTurn> {
    const approvals = createInteractiveApprovalBroker(options);
    const renderState: ProviderRenderState = { streamingText: false };
    const owner = new SessionRunOwner({
        sessionId: options.sessionId,
        store: options.store,
        provider: options.provider,
        modelProviderSelection: options.modelProviderSelection,
        toolRegistry: await createInteractiveToolRegistry(options, approvals),
        ...(options.observeStoredEvent !== undefined ? { onDurableEvent: options.observeStoredEvent } : {}),
        onProviderEnvelope: (envelope: AgentEventEnvelope) =>
            renderProviderEnvelope(options.output, renderState, envelope),
        onToolCall: (toolCall: ToolCall) => preapproveInteractiveToolCall(options.output, toolCall, approvals),
        onToolSettlement: (settlement: ToolInvocationSettlement) =>
            renderInteractiveToolSettlement(options.output, settlement),
    });
    let settled = false;
    const done = runOwnedCodingAgentTurn(options, owner, renderState).finally(() => {
        settled = true;
    });

    return {
        done,
        interrupt: () => {
            approvals.cancel('interrupted by user');
            interruptOwnerUntilSettled(owner, () => settled);
        },
        answerApproval: approvals.answer,
        hasPendingApproval: approvals.hasPending,
    };
}

function interruptOwnerUntilSettled(owner: SessionRunOwner, isSettled: () => boolean): void {
    const interrupt = () => {
        if (!isSettled()) {
            void owner.interrupt('interrupted by user');
        }
    };
    interrupt();
    for (const delayMs of [0, 5, 25]) {
        setTimeout(interrupt, delayMs);
    }
}

async function runOwnedCodingAgentTurn(
    options: CodingAgentTurnOptions,
    owner: SessionRunOwner,
    renderState: ProviderRenderState,
): Promise<void> {
    emitTaskEvent(options, 'task.started', `user prompt: ${options.prompt}`);
    const receipt = await owner.submit({
        prompt: options.prompt,
        inputId: `input_${options.turnId}`,
        messageId: `message_${options.turnId}`,
    });
    settleReceipt(options, receipt, renderState);
}

function settleReceipt(
    options: CodingAgentTurnOptions,
    receipt: SessionRunOwnerReceipt,
    renderState: ProviderRenderState,
): void {
    switch (receipt.status) {
        case 'completed':
            emitTaskEvent(options, 'task.completed', renderState.finalMessage ?? 'run completed');
            return;
        case 'interrupted':
            options.output.write('Interrupted active run\n');
            emitTaskEvent(options, 'task.failed', 'provider turn interrupted');
            return;
        case 'blocked_on_approval':
            options.output.write(`Run blocked: ${receipt.reason ?? 'approval required'}\n`);
            emitTaskEvent(options, 'task.failed', receipt.reason ?? 'approval required');
            return;
        case 'failed':
            emitTaskEvent(options, 'task.failed', receipt.reason ?? 'run failed');
            throw new Error(receipt.reason ?? 'run failed');
        case 'idle':
        case 'running':
        case 'queued':
            return;
        default:
            assertNeverReceipt(receipt.status);
    }
}

type ProviderRenderState = {
    streamingText: boolean;
    finalMessage?: string;
};

function renderProviderEnvelope(output: ChatOutput, state: ProviderRenderState, envelope: AgentEventEnvelope): void {
    const chunk = envelope.event.providerStreamChunk;
    if (chunk?.kind === 'text_delta') {
        if (!state.streamingText) {
            output.write('Assistant: ');
            state.streamingText = true;
        }
        output.write(chunk.delta);
        return;
    }
    if (chunk?.kind !== 'response_completed') {
        return;
    }
    if (state.streamingText) {
        output.write('\n');
        state.streamingText = false;
    } else if (chunk.finishReason !== 'tool_calls') {
        output.write(`Assistant: ${chunk.message.content}\n`);
    }
    if (chunk.finishReason !== 'tool_calls') {
        state.finalMessage = chunk.message.content;
    }
}

async function preapproveInteractiveToolCall(
    output: ChatOutput,
    toolCall: ToolCall,
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
): Promise<ToolInvocationSettlement | undefined> {
    renderToolPreview(toolCall, output);
    if (toolCall.toolName !== 'file.patch' && toolCall.toolName !== 'command.run') {
        return undefined;
    }
    const decision = await approvals.requestApproval({
        id: `approval_${toolCall.toolCallId}`,
        action: toolCall.toolName,
        reason: `approve ${toolCall.toolName}`,
    });
    if (decision.status === 'allow') {
        return undefined;
    }
    return approvalDeniedSettlement(toolCall, decision.reason ?? 'denied');
}

function renderInteractiveToolSettlement(output: ChatOutput, settlement: ToolInvocationSettlement): void {
    if (settlement.result.status === 'failed') {
        output.write(`${settlement.toolName} failed: ${settlement.result.error?.message ?? 'unknown error'}\n`);
        return;
    }
    if (settlement.toolName === 'file.patch') {
        const parsed = parseFilePatchOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (settlement.toolName === 'command.run') {
        if (parseCommandRunStatus(settlement.structuredOutput) === 'failed') {
            output.write('command.run failed: command_failed\n');
            return;
        }
        output.write(`Command output for command.run\n${settlement.modelOutput?.content ?? ''}\n`);
    }
}

function parseCommandRunStatus(value: unknown): 'completed' | 'failed' | undefined {
    if (!isRecord(value) || value.kind !== 'command_run') {
        return undefined;
    }
    return value.status === 'completed' || value.status === 'failed' ? value.status : undefined;
}

function approvalDeniedSettlement(toolCall: ToolCall, reason: string): ToolInvocationSettlement {
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: {
            toolCallId: toolCall.toolCallId,
            status: 'failed',
            error: {
                code: 'tool_failed',
                message: `approval_denied: ${reason}`,
                retryable: false,
            },
        },
        events: [],
    };
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

function assertNeverReceipt(value: never): never {
    throw new Error(`Unexpected run owner receipt status: ${String(value)}`);
}

function isRecord(value: unknown): value is { readonly kind?: unknown; readonly status?: unknown } {
    return typeof value === 'object' && value !== null;
}
