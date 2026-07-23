import { redactCredentialText, type ToolInvocationSettlement } from '@mission-control/core';
import type { AbgSignal } from '@mission-control/protocol';
import { sanitizeTerminalDisplayText } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { reportGraphRenderFailure } from './interactive-coding-graph-render-failure';
import {
    describeRetryableFailure,
    formatNodeRetryStatus,
    formatNodeWorkingStatus,
    formatProviderWaitStatus,
    formatThinkingStatus,
} from './interactive-coding-graph-status';
import {
    extractSignalError,
    readDeltaFromSignal,
    readNumberField,
    readReasoningDeltaFromSignal,
    readStringField,
    readToolCallProposal,
} from './interactive-coding-signal-payload';
import { renderToolPreview } from './interactive-coding-tool-preview';
import {
    currentGraphTurnPrefix,
    graphOccurrencePartId,
    graphTurnPartId,
    noteAssistantAttribution,
    openGraphTurn,
    type ProviderRenderState,
    recordGraphErrorEmission,
} from './interactive-coding-transcript-render-state';
import {
    type InteractiveGraphSignalObserver,
    notifyInteractiveGraphSignalObservers,
} from './interactive-graph-signal-observers';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';

export { renderInteractiveGraphDurableEvent } from './interactive-coding-graph-durable-rendering';

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
            reportGraphRenderFailure(output, error instanceof Error ? error : new Error(String(error)));
        }
        notifyInteractiveGraphSignalObservers(extraObservers, signal);
    };
}

function renderInteractiveGraphSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    signal: AbgSignal,
): Promise<void> | undefined {
    if (signal.type === 'started') {
        closeStreams(output, state);
        const statusText = formatNodeWorkingStatus(sanitizeTerminalDisplayText(signal.nodeId));
        emitTranscriptPart(
            output,
            { id: graphOccurrencePartId(state), type: 'status', text: statusText, status: 'running' },
            `▸ ${signal.nodeId}\n`,
        );
        output.setAgentStatus?.(statusText);
        return;
    }
    if (signal.type === 'failure') {
        closeStreams(output, state);
        const failure = describeRetryableFailure(signal.error);
        if (failure.retryable) {
            // Keep the spinner above the prompt; durable attempt.failed fills attempt/max.
            output.setAgentStatus?.(
                formatNodeRetryStatus({
                    nodeId: sanitizeTerminalDisplayText(signal.nodeId),
                    shortReason: sanitizeTerminalDisplayText(failure.shortReason),
                }),
            );
            return;
        }
        output.clearAgentStatus?.();
        const redactedErrorText = redactCredentialText(extractSignalError(signal.error));
        const turnPrefix = currentGraphTurnPrefix(state, signal.nodeId);
        const fallbackText = `✗ ${signal.nodeId}: ${redactedErrorText}\n`;
        if (turnPrefix === undefined) {
            emitTranscriptFallback(output, fallbackText);
        } else {
            emitTranscriptPart(
                output,
                {
                    id: graphTurnPartId(turnPrefix, 'error'),
                    type: 'error',
                    text: redactedErrorText,
                    error: redactedErrorText,
                    status: 'failed',
                },
                fallbackText,
            );
        }
        recordGraphErrorEmission(state, {
            reason: redactedErrorText,
            typedPartEmitted: turnPrefix !== undefined && output.writeTranscriptPart !== undefined,
            exactReceiptFallbackWritten: false,
        });
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'workflow.transitioned') {
        emitTranscriptPart(
            output,
            {
                id: graphOccurrencePartId(state, signal.event.id),
                type: 'event',
                text: signal.event.type,
                status: 'informational',
                eventId: signal.event.id,
                eventType: signal.event.type,
                timestamp: signal.event.timestamp,
            },
            '',
        );
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'llm.provider_wait') {
        const delayMs = readNumberField(signal.event.payload, 'delayMs');
        const attempt = readNumberField(signal.event.payload, 'attempt');
        if (delayMs === undefined || delayMs < 0 || attempt === undefined || attempt < 1) return;
        const statusText = formatProviderWaitStatus(sanitizeTerminalDisplayText(signal.nodeId), attempt);
        const retryAt = Date.now() + delayMs;
        if (output.setAgentRetryStatus === undefined) {
            output.setAgentStatus?.(statusText);
        } else {
            output.setAgentRetryStatus(statusText, retryAt);
        }
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'llm.turn.started') {
        openGraphTurn(state, signal.nodeId, signal.event.id);
        output.setAgentStatus?.(formatThinkingStatus(signal.nodeId));
        return;
    }
    const reasoningDelta = readReasoningDeltaFromSignal(signal);
    if (reasoningDelta !== undefined) {
        const turnPrefix = currentGraphTurnPrefix(state, signal.nodeId);
        const partId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'reasoning');
        const redactedDelta = redactCredentialText(reasoningDelta, []);
        const text =
            partId === undefined ? redactedDelta : `${state.reasoningTextByRequest.get(partId) ?? ''}${redactedDelta}`;
        if (partId !== undefined) state.reasoningTextByRequest.set(partId, text);
        let fallbackText = '';
        if (output.isShowThinking?.() !== false) {
            const continuesActiveThinking = state.streamingThinking && state.streamingThinkingPartId === partId;
            if (!continuesActiveThinking) {
                if (state.streamingText || state.streamingThinking) emitTranscriptFallback(output, '\n');
                state.streamingText = false;
                delete state.streamingTextPartId;
                fallbackText = `Thinking: ${redactedDelta}`;
                state.streamingThinking = true;
                if (partId === undefined) {
                    delete state.streamingThinkingPartId;
                } else {
                    state.streamingThinkingPartId = partId;
                }
            } else {
                fallbackText = redactedDelta;
            }
        }
        if (partId === undefined) {
            emitTranscriptFallback(output, fallbackText);
        } else {
            emitTranscriptPart(output, { id: partId, type: 'reasoning', text, status: 'streaming' }, fallbackText);
        }
        return;
    }
    const delta = readDeltaFromSignal(signal);
    if (delta !== undefined) {
        output.clearAgentStatus?.();
        if (state.streamingThinking) {
            emitTranscriptFallback(output, '\n');
            state.streamingThinking = false;
            delete state.streamingThinkingPartId;
        }
        const turnPrefix = currentGraphTurnPrefix(state, signal.nodeId);
        const partId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'assistant');
        const redactedDelta = redactCredentialText(delta, []);
        const text =
            partId === undefined ? redactedDelta : `${state.assistantTextByRequest.get(partId) ?? ''}${redactedDelta}`;
        if (partId !== undefined) state.assistantTextByRequest.set(partId, text);
        const fallbackText = state.streamingText
            ? state.streamingTextPartId === partId
                ? redactedDelta
                : `\nAssistant: ${redactedDelta}`
            : `Assistant: ${redactedDelta}`;
        state.streamingText = true;
        if (partId === undefined) {
            delete state.streamingTextPartId;
            emitTranscriptFallback(output, fallbackText);
        } else {
            state.streamingTextPartId = partId;
            const part = { id: partId, type: 'assistant' as const, text, status: 'streaming' as const };
            noteAssistantAttribution(state, part);
            emitTranscriptPart(output, part, fallbackText);
        }
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'tool.started') {
        const toolName = readStringField(signal.event.payload, 'toolName') ?? 'tool';
        output.setAgentStatus?.(`Running ${sanitizeTerminalDisplayText(toolName)}...`);
        return;
    }
    if (signal.type === 'emit' && (signal.event.type === 'tool.completed' || signal.event.type === 'tool.failed')) {
        // Live-settle the row; durable events are batched at graph end, so without this
        // instant tools stay stuck at "[~] Running" until runAbgGraph returns.
        // Mark toolCallId so the deferred renderInteractiveGraphDurableEvent skips the duplicate.
        const toolCallId = readStringField(signal.event.payload, 'toolCallId');
        if (toolCallId !== undefined && toolCallId.length > 0) {
            state.liveSettledToolCallIds.add(toolCallId);
            renderGraphToolSettlement({
                output,
                state,
                payload: signal.event.payload,
                status: signal.event.type === 'tool.completed' ? 'completed' : 'failed',
            });
        }
        return;
    }
    const proposal = readToolCallProposal(signal);
    if (proposal === undefined) return undefined;
    output.setAgentStatus?.(`Calling ${sanitizeTerminalDisplayText(proposal.toolName)}...`);
    if (state.streamingText) {
        emitTranscriptFallback(output, '\n');
        state.streamingText = false;
        delete state.streamingTextPartId;
    }
    return renderToolPreview(proposal, output, {
        state,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    });
}

function closeStreams(output: ChatOutput, state: ProviderRenderState): void {
    if (state.streamingText || state.streamingThinking) emitTranscriptFallback(output, '\n');
    state.streamingText = false;
    delete state.streamingTextPartId;
    state.streamingThinking = false;
    delete state.streamingThinkingPartId;
}

export type { ToolInvocationSettlement };
