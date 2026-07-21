import { redactCredentialText } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { sanitizeTerminalDisplayText } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';
import {
    describeRetryableFailure,
    formatNodeRetryStatus,
    formatNodeWorkingStatus,
} from './interactive-coding-graph-status';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { formatToolCountSummary, readStringField } from './interactive-coding-signal-payload';
import {
    graphOccurrencePartId,
    graphTurnPartId,
    graphTurnToolSummary,
    nextGraphTerminalTurnPrefix,
    noteAssistantAttribution,
    type ProviderRenderState,
    recordGraphErrorEmission,
    recordGraphTurnTool,
    settleGraphTerminalTurn,
} from './interactive-coding-transcript-render-state';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';

export function renderInteractiveGraphDurableEvent(
    output: ChatOutput,
    state: ProviderRenderState,
    event: AgentEvent,
): void {
    if (event.type === 'decision.selected') {
        renderDecision(output, state, event);
        return;
    }
    if (event.type === 'attempt.started') {
        renderAttemptStarted(output, state, event);
        return;
    }
    if (event.type === 'attempt.failed') {
        renderAttemptFailed(output, event);
        return;
    }

    const emit = event.abg?.emit;
    if (emit === undefined) return;
    if (emit.type === 'llm.turn.completed') {
        output.clearAgentStatus?.();
        const nodeId = event.abg?.nodeId;
        const hasNodeId = typeof nodeId === 'string' && nodeId.length > 0;
        const turnPrefix = hasNodeId ? nextGraphTerminalTurnPrefix(state, nodeId) : undefined;
        const assistantId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'assistant');
        const reasoningId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'reasoning');
        const completesActiveThinking = state.streamingThinking && state.streamingThinkingPartId === reasoningId;
        if (completesActiveThinking) {
            emitTranscriptFallback(output, '\n');
            state.streamingThinking = false;
            delete state.streamingThinkingPartId;
        }
        const toolSummary = turnPrefix === undefined ? undefined : graphTurnToolSummary(state, turnPrefix);
        if (turnPrefix !== undefined && toolSummary !== undefined) {
            const noun = toolSummary.count === 1 ? 'tool' : 'tools';
            const summary = redactCredentialText(
                `✓ ${toolSummary.count} ${noun} (${formatToolCountSummary(toolSummary.names)})`,
                [],
            );
            emitTranscriptPart(
                output,
                { id: graphTurnPartId(turnPrefix, 'tools'), type: 'status', text: summary, status: 'completed' },
                `${summary}\n`,
            );
        }
        const text = readStringField(emit.payload, 'text') ?? '';
        const redactedText = redactCredentialText(text, []);
        const accumulatedText = assistantId === undefined ? undefined : state.assistantTextByRequest.get(assistantId);
        const completedText = redactedText.length > 0 ? redactedText : accumulatedText;
        const completesActiveStream = state.streamingText && state.streamingTextPartId === assistantId;
        const fallbackText = completesActiveStream
            ? '\n'
            : accumulatedText !== undefined
              ? ''
              : redactedText.length > 0
                ? `Assistant: ${redactedText}\n`
                : '';
        if (completesActiveStream) {
            state.streamingText = false;
            delete state.streamingTextPartId;
        }
        if (assistantId !== undefined && completedText !== undefined && completedText.length > 0) {
            state.assistantTextByRequest.set(assistantId, completedText);
            const assistantPart = {
                id: assistantId,
                type: 'assistant' as const,
                text: completedText,
                status: 'completed' as const,
            };
            noteAssistantAttribution(state, assistantPart);
            emitTranscriptPart(output, assistantPart, fallbackText);
        } else if (fallbackText.length > 0) {
            emitTranscriptFallback(output, fallbackText);
        }
        if (reasoningId !== undefined) {
            const reasoningText = state.reasoningTextByRequest.get(reasoningId);
            if (reasoningText !== undefined) {
                emitTranscriptPart(
                    output,
                    { id: reasoningId, type: 'reasoning', text: reasoningText, status: 'completed' },
                    '',
                );
            }
        }
        if (text.length > 0) state.finalMessage = text;
        if (turnPrefix !== undefined && hasNodeId) settleGraphTerminalTurn(state, nodeId, turnPrefix);
        return;
    }
    if (emit.type === 'tool.completed' || emit.type === 'tool.failed') {
        const nodeId = event.abg?.nodeId;
        const turnPrefix =
            typeof nodeId === 'string' && nodeId.length > 0
                ? recordGraphTurnTool(state, nodeId, readStringField(emit.payload, 'toolName') ?? 'tool')
                : undefined;
        const assistantId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'assistant');
        const reasoningId = turnPrefix === undefined ? undefined : graphTurnPartId(turnPrefix, 'reasoning');
        output.clearAgentStatus?.();
        if (
            (state.streamingText && state.streamingTextPartId === assistantId) ||
            (state.streamingThinking && state.streamingThinkingPartId === reasoningId)
        ) {
            emitTranscriptFallback(output, '\n');
            state.streamingText = false;
            delete state.streamingTextPartId;
            state.streamingThinking = false;
            delete state.streamingThinkingPartId;
        }
        renderGraphToolSettlement({
            output,
            state,
            payload: emit.payload,
            status: emit.type === 'tool.completed' ? 'completed' : 'failed',
        });
        return;
    }
    if (emit.type === 'llm.error') renderLlmError(output, state, event, emit.payload);
}

function renderDecision(output: ChatOutput, state: ProviderRenderState, event: AgentEvent): void {
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    const fallbackText = message.length > 0 ? `→ ${message}\n` : '';
    const nodeId = event.abg?.nodeId;
    if (typeof nodeId === 'string' && nodeId.length > 0) {
        emitTranscriptPart(
            output,
            {
                id: graphOccurrencePartId(state),
                type: 'event',
                text: redactCredentialText(message),
                status: 'informational',
                eventType: event.type,
                timestamp: event.timestamp,
            },
            fallbackText,
        );
    } else if (fallbackText.length > 0) {
        emitTranscriptFallback(output, fallbackText);
    }
}

function renderAttemptStarted(output: ChatOutput, state: ProviderRenderState, event: AgentEvent): void {
    const nodeId = event.abg?.nodeId;
    if (typeof nodeId !== 'string' || nodeId.length === 0) return;
    const attempt = typeof event.abg?.attempt === 'number' ? event.abg.attempt : undefined;
    const statusText = formatNodeWorkingStatus(sanitizeTerminalDisplayText(nodeId), attempt);
    output.setAgentStatus?.(statusText);
    emitTranscriptPart(
        output,
        { id: graphOccurrencePartId(state), type: 'status', text: statusText, status: 'running' },
        '',
    );
}

function renderAttemptFailed(output: ChatOutput, event: AgentEvent): void {
    const nodeId = event.abg?.nodeId;
    const failure = describeRetryableFailure(event.abg?.error);
    if (typeof nodeId === 'string' && nodeId.length > 0 && failure.retryable) {
        output.setAgentStatus?.(
            formatNodeRetryStatus({
                nodeId: sanitizeTerminalDisplayText(nodeId),
                shortReason: sanitizeTerminalDisplayText(failure.shortReason),
                ...(typeof event.abg?.attempt === 'number' ? { attempt: event.abg.attempt } : {}),
                ...(typeof event.abg?.maxAttempts === 'number' ? { maxAttempts: event.abg.maxAttempts } : {}),
            }),
        );
        return;
    }
    output.clearAgentStatus?.();
}

function renderLlmError(output: ChatOutput, state: ProviderRenderState, event: AgentEvent, payload: unknown): void {
    const errorText = readStringField(payload, 'error') ?? 'LLM error';
    const errorCode = readStringField(payload, 'errorCode');
    const failure = describeRetryableFailure({
        message: errorText,
        ...(errorCode !== undefined ? { code: errorCode, retryable: true } : {}),
    });
    const nodeId = event.abg?.nodeId;
    const hasNodeId = typeof nodeId === 'string' && nodeId.length > 0;
    const turnPrefix = hasNodeId ? nextGraphTerminalTurnPrefix(state, nodeId) : undefined;
    const willRetry = failure.retryable && hasNodeId;
    const redactedError = redactCredentialText(errorText);
    const fallbackText = willRetry ? '' : `Error: ${redactedError}\n`;
    if (turnPrefix !== undefined) {
        emitTranscriptPart(
            output,
            {
                id: graphTurnPartId(turnPrefix, 'error'),
                type: 'error',
                text: redactedError,
                error: redactedError,
                status: 'failed',
                ...(errorCode !== undefined ? { code: errorCode } : {}),
            },
            fallbackText,
        );
    } else if (fallbackText.length > 0) {
        emitTranscriptFallback(output, fallbackText);
    }
    const typedPartEmitted = turnPrefix !== undefined && output.writeTranscriptPart !== undefined;
    const exactReceiptFallbackWritten = fallbackText.length > 0;
    if (typedPartEmitted || exactReceiptFallbackWritten) {
        recordGraphErrorEmission(state, {
            reason: redactedError,
            typedPartEmitted,
            exactReceiptFallbackWritten,
        });
    }
    if (turnPrefix !== undefined && hasNodeId) settleGraphTerminalTurn(state, nodeId, turnPrefix);
    if (willRetry) {
        output.setAgentStatus?.(
            formatNodeRetryStatus({
                nodeId: sanitizeTerminalDisplayText(nodeId),
                shortReason: sanitizeTerminalDisplayText(failure.shortReason),
                ...(typeof event.abg?.attempt === 'number' ? { attempt: event.abg.attempt } : {}),
                ...(typeof event.abg?.maxAttempts === 'number' ? { maxAttempts: event.abg.maxAttempts } : {}),
            }),
        );
        return;
    }
    output.clearAgentStatus?.();
}
