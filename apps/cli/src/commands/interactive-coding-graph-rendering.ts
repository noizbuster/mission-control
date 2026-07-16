import { redactCredentialText, type ToolInvocationSettlement } from '@mission-control/core';
import type { AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview';
import {
    extractSignalError,
    formatToolCountSummary,
    readDeltaFromSignal,
    readErrorMessage,
    readReasoningDeltaFromSignal,
    readStringField,
    readToolCallProposal,
    structuredToolOutput,
} from './interactive-coding-signal-payload';
import { parseFileEditOutput, parseFilePatchOutput, renderToolPreview } from './interactive-coding-tool-preview';
import { formatToolResultActivity } from './interactive-coding-tool-activity';
import {
    describeRetryableFailure,
    formatNodeRetryStatus,
    formatNodeWorkingStatus,
} from './interactive-coding-graph-status';
import {
    type InteractiveGraphSignalObserver,
    notifyInteractiveGraphSignalObservers,
} from './interactive-graph-signal-observers';

export type ProviderRenderState = {
    streamingText: boolean;
    streamingThinking: boolean;
    finalMessage?: string;
    toolCount: number;
    toolNames: string[];
};

export function interactiveGraphStreamSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    extraObservers: readonly InteractiveGraphSignalObserver[] = [],
): (signal: AbgSignal) => Promise<void> {
    return async (signal) => {
        try {
            const renderResult = renderInteractiveGraphSignal(output, state, workspaceRoot, signal);
            if (renderResult !== undefined) await renderResult;
        } catch (error: unknown) {
            reportGraphRenderFailure(output, error);
        }
        notifyInteractiveGraphSignalObservers(extraObservers, signal);
    };
}

function reportGraphRenderFailure(output: ChatOutput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Interactive graph render failed: ${message}\n`);
    try {
        output.write(`Error: ${message}\n`);
    } catch (writeError: unknown) {
        const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
        process.stderr.write(`Interactive graph render error write failed: ${writeMessage}\n`);
    }
}

export function renderInteractiveGraphDurableEvent(
    output: ChatOutput,
    state: ProviderRenderState,
    event: AgentEvent,
): void {
    if (event.type === 'decision.selected') {
        const message = typeof event.message === 'string' ? event.message.trim() : '';
        if (message.length > 0) {
            output.write(`→ ${message}\n`);
        }
        return;
    }
    if (event.type === 'attempt.started') {
        const nodeId = event.abg?.nodeId;
        if (typeof nodeId === 'string' && nodeId.length > 0) {
            const attempt = typeof event.abg?.attempt === 'number' ? event.abg.attempt : undefined;
            output.setAgentStatus?.(formatNodeWorkingStatus(nodeId, attempt));
        }
        return;
    }
    if (event.type === 'attempt.failed') {
        const nodeId = event.abg?.nodeId;
        const failure = describeRetryableFailure(event.abg?.error);
        if (typeof nodeId === 'string' && nodeId.length > 0 && failure.retryable) {
            output.setAgentStatus?.(
                formatNodeRetryStatus({
                    nodeId,
                    shortReason: failure.shortReason,
                    ...(typeof event.abg?.attempt === 'number' ? { attempt: event.abg.attempt } : {}),
                    ...(typeof event.abg?.maxAttempts === 'number' ? { maxAttempts: event.abg.maxAttempts } : {}),
                }),
            );
            return;
        }
        output.clearAgentStatus?.();
        return;
    }

    const emit = event.abg?.emit;
    if (emit === undefined) return;
    if (emit.type === 'llm.turn.completed') {
        output.clearAgentStatus?.();
        if (state.streamingThinking) {
            output.write('\n');
            state.streamingThinking = false;
        }
        if (state.toolCount > 0) {
            const noun = state.toolCount === 1 ? 'tool' : 'tools';
            output.write(`✓ ${state.toolCount} ${noun} (${formatToolCountSummary(state.toolNames)})\n`);
            state.toolCount = 0;
            state.toolNames = [];
        }
        const text = readStringField(emit.payload, 'text') ?? '';
        if (state.streamingText) {
            output.write('\n');
            state.streamingText = false;
        } else if (text.length > 0) {
            output.write(`Assistant: ${text}\n`);
        }
        if (text.length > 0) state.finalMessage = text;
        return;
    }
    if (emit.type === 'tool.completed' || emit.type === 'tool.failed') {
        state.toolCount += 1;
        state.toolNames = [...state.toolNames, readStringField(emit.payload, 'toolName') ?? 'tool'];
        output.clearAgentStatus?.();
        if (state.streamingText || state.streamingThinking) {
            output.write('\n');
            state.streamingText = false;
            state.streamingThinking = false;
        }
        renderGraphToolSettlement(output, emit.payload, emit.type === 'tool.completed' ? 'completed' : 'failed');
        return;
    }
    if (emit.type === 'llm.error') {
        const errorText = readStringField(emit.payload, 'error') ?? 'LLM error';
        const errorCode = readStringField(emit.payload, 'errorCode');
        const failure = describeRetryableFailure({
            message: errorText,
            ...(errorCode !== undefined ? { code: errorCode, retryable: true } : {}),
        });
        const nodeId = event.abg?.nodeId;
        if (failure.retryable && typeof nodeId === 'string' && nodeId.length > 0) {
            output.setAgentStatus?.(
                formatNodeRetryStatus({
                    nodeId,
                    shortReason: failure.shortReason,
                    ...(typeof event.abg?.attempt === 'number' ? { attempt: event.abg.attempt } : {}),
                    ...(typeof event.abg?.maxAttempts === 'number' ? { maxAttempts: event.abg.maxAttempts } : {}),
                }),
            );
            return;
        }
        output.clearAgentStatus?.();
        output.write(`Error: ${redactCredentialText(errorText)}\n`);
    }
}

function renderInteractiveGraphSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    signal: AbgSignal,
): Promise<void> | undefined {
    if (signal.type === 'started') {
        closeStreams(output, state);
        output.write(`▸ ${signal.nodeId}\n`);
        output.setAgentStatus?.(formatNodeWorkingStatus(signal.nodeId));
        return;
    }
    if (signal.type === 'failure') {
        closeStreams(output, state);
        const failure = describeRetryableFailure(signal.error);
        if (failure.retryable) {
            // Keep the spinner above the prompt; durable attempt.failed fills attempt/max.
            output.setAgentStatus?.(
                formatNodeRetryStatus({
                    nodeId: signal.nodeId,
                    shortReason: failure.shortReason,
                }),
            );
            return;
        }
        output.clearAgentStatus?.();
        output.write(`✗ ${signal.nodeId}: ${extractSignalError(signal.error)}\n`);
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'llm.turn.started') {
        output.setAgentStatus?.('Thinking...');
        return;
    }
    const reasoningDelta = readReasoningDeltaFromSignal(signal);
    if (reasoningDelta !== undefined) {
        if (output.isShowThinking?.() !== false) {
            if (!state.streamingThinking) {
                if (state.streamingText) {
                    output.write('\n');
                    state.streamingText = false;
                }
                output.write('Thinking: ');
                state.streamingThinking = true;
            }
            output.write(reasoningDelta);
        }
        return;
    }
    const delta = readDeltaFromSignal(signal);
    if (delta !== undefined) {
        output.clearAgentStatus?.();
        if (state.streamingThinking) {
            output.write('\n');
            state.streamingThinking = false;
        }
        if (!state.streamingText) {
            output.write('Assistant: ');
            state.streamingText = true;
        }
        output.write(delta);
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'tool.started') {
        output.setAgentStatus?.(`Running ${readStringField(signal.event.payload, 'toolName') ?? 'tool'}...`);
        return;
    }
    const proposal = readToolCallProposal(signal);
    if (proposal === undefined) return undefined;
    output.setAgentStatus?.(`Calling ${proposal.toolName}...`);
    if (state.streamingText) {
        output.write('\n');
        state.streamingText = false;
    }
    return renderToolPreview(proposal, output, workspaceRoot);
}

function renderGraphToolSettlement(output: ChatOutput, payload: unknown, status: 'completed' | 'failed'): void {
    const toolName = readStringField(payload, 'toolName') ?? 'tool';
    const modelOutput = readStringField(payload, 'output');
    const structured = structuredToolOutput(payload);
    output.write(
        `${formatToolResultActivity(toolName, status, {
            ...(modelOutput !== undefined ? { modelOutput } : {}),
            ...(structured !== undefined ? { structuredOutput: structured } : {}),
            ...(status === 'failed'
                ? { errorMessage: readErrorMessage(payload) ?? 'unknown error' }
                : {}),
        })}\n`,
    );
    if (output.isToolOutputExpanded?.() === false) return;
    if (status === 'failed') return;
    if (toolName === 'command.run' || toolName === 'bash.run') {
        if (modelOutput !== undefined && modelOutput.includes('\n')) {
            output.write(`Command output for ${toolName}\n${modelOutput}\n`);
        }
        return;
    }
    if (toolName === 'file.patch') {
        const parsed = structured === undefined ? undefined : parseFilePatchOutput(structured);
        if (parsed !== undefined && parsed.appliedFiles.length > 1) {
            output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (toolName === 'file.edit') {
        const parsed = structured === undefined ? undefined : parseFileEditOutput(structured);
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            output.write(`Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`);
        }
        return;
    }
    if (toolName === 'file.write') {
        const parsed = structured === undefined ? undefined : parseFileWriteOutput(structured);
        if (parsed !== undefined) {
            output.write(
                `${parsed.operation === 'created' ? 'Created' : 'Replaced'} file: ${parsed.appliedFiles.join(', ')}\n`,
            );
        }
    }
}

function closeStreams(output: ChatOutput, state: ProviderRenderState): void {
    if (state.streamingText || state.streamingThinking) output.write('\n');
    state.streamingText = false;
    state.streamingThinking = false;
}

export type { ToolInvocationSettlement };
