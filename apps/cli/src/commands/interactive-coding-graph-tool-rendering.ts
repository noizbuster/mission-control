import { redactCredentialText } from '@mission-control/core';
import type { ChatOutput } from './interactive-chat-io';
import { projectFileResultParts } from './interactive-coding-file-transcript';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview';
import { readErrorMessage, readStringField, structuredToolOutput } from './interactive-coding-signal-payload';
import { formatToolResultActivity } from './interactive-coding-tool-activity';
import { parseFileEditOutput, parseFilePatchOutput } from './interactive-coding-tool-preview';
import { projectToolSettlementPart } from './interactive-coding-tool-transcript';
import {
    claimToolTranscriptOccurrence,
    type ProviderRenderState,
    retireActiveToolTranscriptParts,
} from './interactive-coding-transcript-render-state';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';

export type GraphToolSettlementRenderInput = {
    readonly output: ChatOutput;
    readonly state: ProviderRenderState;
    readonly payload: unknown;
    readonly status: 'completed' | 'failed';
};

export function renderGraphToolSettlement(input: GraphToolSettlementRenderInput): void {
    const { output, state, payload, status } = input;
    const toolName = readStringField(payload, 'toolName') ?? 'tool';
    const toolCallId = readStringField(payload, 'toolCallId');
    const modelOutput = readStringField(payload, 'output');
    const structured = structuredToolOutput(payload);
    const errorMessage = status === 'failed' ? (readErrorMessage(payload) ?? 'unknown error') : undefined;
    const fallbackText = `${redactCredentialText(
        formatToolResultActivity(toolName, status, {
            ...(modelOutput !== undefined ? { modelOutput } : {}),
            ...(structured !== undefined ? { structuredOutput: structured } : {}),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
        }),
        [],
    )}\n`;
    const toolBaseId =
        toolCallId !== undefined && toolCallId.length > 0
            ? claimToolTranscriptOccurrence(state, toolCallId)
            : undefined;
    const settlementPart =
        toolCallId !== undefined && toolBaseId !== undefined
            ? projectToolSettlementPart({
                  toolBaseId,
                  toolCallId,
                  toolName,
                  status,
                  ...(modelOutput !== undefined ? { modelOutput } : {}),
                  ...(structured !== undefined ? { structuredOutput: structured } : {}),
                  ...(errorMessage !== undefined ? { errorMessage } : {}),
              })
            : undefined;
    if (settlementPart !== undefined) {
        retireActiveToolTranscriptParts(state, settlementPart.id);
        emitTranscriptPart(output, settlementPart, fallbackText);
    } else {
        emitTranscriptFallback(output, fallbackText);
    }
    if (status === 'failed') return;
    if (toolCallId !== undefined && toolBaseId !== undefined) {
        for (const part of projectFileResultParts({
            toolBaseId,
            toolCallId,
            structuredOutput: structured,
            events: [],
        })) {
            emitTranscriptPart(output, part, '');
        }
    }
    if (output.isToolOutputExpanded?.() === false) return;
    if (toolName === 'command.run' || toolName === 'bash.run') {
        if (modelOutput?.includes('\n')) {
            emitTranscriptFallback(
                output,
                redactCredentialText(`Command output for ${toolName}\n${modelOutput}\n`, []),
            );
        }
        return;
    }
    if (toolName === 'file.patch') {
        const parsed = structured === undefined ? undefined : parseFilePatchOutput(structured);
        if (parsed !== undefined && parsed.appliedFiles.length > 1) {
            emitTranscriptFallback(
                output,
                redactCredentialText(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`, []),
            );
        }
        return;
    }
    if (toolName === 'file.edit') {
        const parsed = structured === undefined ? undefined : parseFileEditOutput(structured);
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
    if (toolName === 'file.write') {
        const parsed = structured === undefined ? undefined : parseFileWriteOutput(structured);
        if (parsed !== undefined) {
            emitTranscriptFallback(
                output,
                redactCredentialText(
                    `${parsed.operation === 'created' ? 'Created' : 'Replaced'} file: ${parsed.appliedFiles.join(', ')}\n`,
                    [],
                ),
            );
        }
    }
}
