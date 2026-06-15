import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type JsonlSessionEventStore,
    ProjectTrustStore,
    type ProviderAdapter,
    projectApprovalContinuationMessages,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type ToolInvocationSettlement,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview.js';
import { parseFileEditOutput, parseFilePatchOutput } from './interactive-coding-tool-preview.js';
import { createInteractiveToolRegistry, preflightInteractiveToolCall } from './interactive-coding-tools.js';

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
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: `user prompt: ${options.prompt}`,
        execute: (owner) =>
            owner.submit({
                prompt: options.prompt,
                inputId: `input_${options.turnId}`,
                messageId: `message_${options.turnId}`,
            }),
    });
}

export async function resumeCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'>,
): Promise<ActiveCodingAgentTurn> {
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: 'resume blocked run',
        execute: (owner) => owner.resume(),
    });
}

async function startOwnedCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    action: {
        readonly taskStartedMessage: string;
        readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
    },
): Promise<ActiveCodingAgentTurn> {
    const approvals = createInteractiveApprovalBroker(options);
    const renderState: ProviderRenderState = { streamingText: false };
    const owner = await createInteractiveRunOwner(options, approvals, renderState);
    let settled = false;
    const done = runOwnedCodingAgentTurn(options, owner, renderState, action)
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            options.output.write(`Error: ${message}\n`);
        })
        .finally(() => {
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

async function createInteractiveRunOwner(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
    renderState: ProviderRenderState,
): Promise<SessionRunOwner> {
    const toolOptions = {
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        modelProviderSelection: options.modelProviderSelection,
        output: options.output,
        emitEvent: options.emitEvent,
        enableTrustedBash: await workspaceHasTrustedBash(options.workspaceRoot),
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
    };
    const toolRegistry = await createInteractiveToolRegistry(toolOptions, approvals);
    return new SessionRunOwner({
        sessionId: options.sessionId,
        store: options.store,
        provider: options.provider,
        modelProviderSelection: options.modelProviderSelection,
        projectContext: { workspaceRoot: options.workspaceRoot },
        readMessages: async () =>
            projectApprovalContinuationMessages(await options.store.getEvents(options.sessionId), options.sessionId),
        toolRegistry,
        ...(options.observeStoredEvent !== undefined ? { onDurableEvent: options.observeStoredEvent } : {}),
        onProviderEnvelope: (envelope: AgentEventEnvelope) =>
            renderProviderEnvelope(options.output, renderState, envelope),
        onToolCall: (toolCall: ToolCall) => preflightInteractiveToolCall(toolCall, toolOptions, approvals),
        onToolSettlement: (settlement: ToolInvocationSettlement) =>
            renderInteractiveToolSettlement(options.output, settlement),
    });
}

async function workspaceHasTrustedBash(workspaceRoot: string): Promise<boolean> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return trust.decision === 'trusted';
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
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    owner: SessionRunOwner,
    renderState: ProviderRenderState,
    action: {
        readonly taskStartedMessage: string;
        readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
    },
): Promise<void> {
    emitTaskEvent(options, 'task.started', action.taskStartedMessage);
    const receipt = await action.execute(owner);
    settleReceipt(options, receipt, renderState);
}

function settleReceipt(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
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
            options.output.write(formatBlockedRunMessage(receipt.reason ?? 'approval required', receipt.toolCallId));
            return;
        case 'failed':
            options.output.write(`Error: ${receipt.reason ?? 'run failed'}\n`);
            emitTaskEvent(options, 'task.failed', receipt.reason ?? 'run failed');
            return;
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
    if (settlement.toolName === 'file.edit') {
        const parsed = parseFileEditOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            output.write(`Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`);
        }
        return;
    }
    if (settlement.toolName === 'file.write') {
        const parsed = parseFileWriteOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const verb = parsed.operation === 'created' ? 'Created' : 'Replaced';
            output.write(`${verb} file: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (settlement.toolName === 'command.run' || settlement.toolName === 'bash.run') {
        if (parseCommandRunStatus(settlement.structuredOutput) === 'failed') {
            output.write(`${settlement.toolName} failed: command_failed\n`);
            return;
        }
        output.write(`Command output for ${settlement.toolName}\n${settlement.modelOutput?.content ?? ''}\n`);
    }
}

function parseCommandRunStatus(value: unknown): 'completed' | 'failed' | undefined {
    if (!isRecord(value) || value.kind !== 'command_run') {
        return undefined;
    }
    return value.status === 'completed' || value.status === 'failed' ? value.status : undefined;
}

function emitTaskEvent(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
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

function formatBlockedRunMessage(reason: string, toolCallId?: string): string {
    const details = toolCallId === undefined ? '' : ` Pending tool call: ${toolCallId}.`;
    return `Run blocked (resumable): ${reason}. Resume with /resume.${details}\n`;
}

function assertNeverReceipt(value: never): never {
    throw new Error(`Unexpected run owner receipt status: ${String(value)}`);
}

function isRecord(value: unknown): value is { readonly kind?: unknown; readonly status?: unknown } {
    return typeof value === 'object' && value !== null;
}
