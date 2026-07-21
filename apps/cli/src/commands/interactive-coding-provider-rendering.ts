import { redactCredentialText, type ToolInvocationSettlement } from '@mission-control/core';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { AssistantTranscriptPart, ReasoningTranscriptPart } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';
import { projectFileResultParts } from './interactive-coding-file-transcript';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview';
import { parseCommandRunStatus } from './interactive-coding-signal-payload';
import { formatToolResultActivity } from './interactive-coding-tool-activity';
import { parseFileEditOutput, parseFilePatchOutput } from './interactive-coding-tool-preview';
import { projectToolSettlementPart } from './interactive-coding-tool-transcript';
import {
    claimToolTranscriptOccurrence,
    noteAssistantAttribution,
    type ProviderRenderState,
    providerTranscriptPartId,
    retireActiveToolTranscriptParts,
} from './interactive-coding-transcript-render-state';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';

export function renderProviderEnvelope(
    output: ChatOutput,
    state: ProviderRenderState,
    envelope: AgentEventEnvelope,
): void {
    const chunk = envelope.event.providerStreamChunk;
    if (chunk === undefined) return;
    switch (chunk.kind) {
        case 'text_delta': {
            const partId = providerTranscriptPartId(state.executionTurnId, chunk.requestId, 'assistant');
            const fallbackText = state.streamingText
                ? state.streamingTextPartId === partId
                    ? chunk.delta
                    : `\nAssistant: ${chunk.delta}`
                : `Assistant: ${chunk.delta}`;
            state.streamingText = true;
            state.streamingTextPartId = partId;
            const text = `${state.assistantTextByRequest.get(partId) ?? ''}${chunk.delta}`;
            state.assistantTextByRequest.set(partId, text);
            const part: AssistantTranscriptPart & { readonly requestId: string } = {
                id: partId,
                type: 'assistant',
                text: redactCredentialText(text, []),
                status: 'streaming',
                requestId: chunk.requestId,
            };
            noteAssistantAttribution(state, part);
            emitTranscriptPart(output, part, fallbackText);
            return;
        }
        case 'reasoning_delta': {
            const partId = providerTranscriptPartId(state.executionTurnId, chunk.requestId, 'reasoning');
            const text = `${state.reasoningTextByRequest.get(partId) ?? ''}${chunk.delta}`;
            state.reasoningTextByRequest.set(partId, text);
            const part: ReasoningTranscriptPart & { readonly requestId: string } = {
                id: partId,
                type: 'reasoning',
                text: redactCredentialText(text, []),
                status: 'streaming',
                requestId: chunk.requestId,
            };
            emitTranscriptPart(output, part, '');
            return;
        }
        case 'reasoning_completed': {
            const partId = providerTranscriptPartId(state.executionTurnId, chunk.requestId, 'reasoning');
            state.reasoningTextByRequest.set(partId, chunk.text);
            const part: ReasoningTranscriptPart & { readonly requestId: string } = {
                id: partId,
                type: 'reasoning',
                text: redactCredentialText(chunk.text, []),
                status: 'completed',
                requestId: chunk.requestId,
            };
            emitTranscriptPart(output, part, '');
            return;
        }
        case 'response_completed': {
            const partId = providerTranscriptPartId(state.executionTurnId, chunk.requestId, 'assistant');
            const hadStreamingOutput = state.assistantTextByRequest.has(partId);
            const completesActiveStream = state.streamingText && state.streamingTextPartId === partId;
            const fallbackText = completesActiveStream
                ? '\n'
                : chunk.finishReason === 'tool_calls'
                  ? ''
                  : hadStreamingOutput
                    ? ''
                    : `Assistant: ${chunk.message.content}\n`;
            if (completesActiveStream) {
                state.streamingText = false;
                delete state.streamingTextPartId;
            }
            state.assistantTextByRequest.set(partId, chunk.message.content);
            const part: AssistantTranscriptPart & { readonly requestId: string } = {
                id: partId,
                type: 'assistant',
                text: redactCredentialText(chunk.message.content, []),
                status: 'completed',
                messageId: chunk.message.messageId,
                requestId: chunk.requestId,
            };
            noteAssistantAttribution(state, part);
            emitTranscriptPart(output, part, fallbackText);
            if (chunk.finishReason !== 'tool_calls') state.finalMessage = chunk.message.content;
            return;
        }
        case 'response_started':
        case 'tool_call_delta':
        case 'tool_call_completed':
        case 'response_failed':
            return;
        default:
            assertNeverProviderChunk(chunk);
    }
}

export function renderInteractiveToolSettlement(
    output: ChatOutput,
    settlement: ToolInvocationSettlement,
    state: ProviderRenderState,
): void {
    const status = settlement.result.status === 'failed' ? 'failed' : 'completed';
    const modelOutput = settlement.modelOutput?.content;
    const transcriptOutput = modelOutput ?? settlement.result.output;
    const fallbackText = `${redactCredentialText(
        formatToolResultActivity(settlement.toolName, status, {
            ...(modelOutput !== undefined ? { modelOutput } : {}),
            ...(settlement.structuredOutput !== undefined ? { structuredOutput: settlement.structuredOutput } : {}),
            ...(status === 'failed' ? { errorMessage: settlement.result.error?.message ?? 'unknown error' } : {}),
        }),
        [],
    )}\n`;
    const toolBaseId = claimToolTranscriptOccurrence(state, settlement.toolCallId);
    const messageId = state.lastAssistantAttributionId;
    const settlementPart = projectToolSettlementPart({
        toolBaseId,
        toolCallId: settlement.toolCallId,
        toolName: settlement.toolName,
        status,
        ...(transcriptOutput !== undefined ? { modelOutput: transcriptOutput } : {}),
        ...(settlement.modelOutput !== undefined ? { modelOutputTruncated: settlement.modelOutput.truncated } : {}),
        ...(settlement.structuredOutput !== undefined ? { structuredOutput: settlement.structuredOutput } : {}),
        ...(status === 'failed' ? { errorMessage: settlement.result.error?.message ?? 'unknown error' } : {}),
        ...(messageId ? { messageId } : {}),
    });
    retireActiveToolTranscriptParts(state, settlementPart.id);
    emitTranscriptPart(output, settlementPart, fallbackText);
    if (status === 'failed') return;
    for (const part of projectFileResultParts({
        toolBaseId,
        toolCallId: settlement.toolCallId,
        structuredOutput: settlement.structuredOutput,
        events: settlement.events,
        ...(messageId ? { messageId } : {}),
    })) {
        emitTranscriptPart(output, part, '');
    }
    if (output.isToolOutputExpanded?.() === false) return;
    if (settlement.toolName === 'file.patch') {
        const parsed = parseFilePatchOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            emitTranscriptFallback(
                output,
                redactCredentialText(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`, []),
            );
        }
        return;
    }
    if (settlement.toolName === 'file.edit') {
        const parsed = parseFileEditOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            emitTranscriptFallback(
                output,
                redactCredentialText(
                    `Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`,
                    [],
                ),
            );
        }
        return;
    }
    if (settlement.toolName === 'file.write') {
        const parsed = parseFileWriteOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const verb = parsed.operation === 'created' ? 'Created' : 'Replaced';
            emitTranscriptFallback(
                output,
                redactCredentialText(`${verb} file: ${parsed.appliedFiles.join(', ')}\n`, []),
            );
        }
        return;
    }
    if (settlement.toolName === 'command.run' || settlement.toolName === 'bash.run') {
        if (parseCommandRunStatus(settlement.structuredOutput) === 'failed') {
            return;
        }
        const content = settlement.modelOutput?.content ?? '';
        if (content.includes('\n')) {
            emitTranscriptFallback(
                output,
                redactCredentialText(`Command output for ${settlement.toolName}\n${content}\n`, []),
            );
        }
    }
}

function assertNeverProviderChunk(chunk: never): never {
    throw new Error(`Unsupported provider chunk: ${JSON.stringify(chunk)}`);
}
