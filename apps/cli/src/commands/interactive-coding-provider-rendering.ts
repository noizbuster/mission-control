import type { ToolInvocationSettlement } from '@mission-control/core';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview';
import type { ProviderRenderState } from './interactive-coding-graph-rendering';
import { parseCommandRunStatus } from './interactive-coding-signal-payload';
import { formatToolResultActivity } from './interactive-coding-tool-activity';
import { parseFileEditOutput, parseFilePatchOutput } from './interactive-coding-tool-preview';

export function renderProviderEnvelope(
    output: ChatOutput,
    state: ProviderRenderState,
    envelope: AgentEventEnvelope,
): void {
    const chunk = envelope.event.providerStreamChunk;
    if (chunk?.kind === 'text_delta') {
        if (!state.streamingText) {
            output.write('Assistant: ');
            state.streamingText = true;
        }
        output.write(chunk.delta);
        return;
    }
    if (chunk?.kind !== 'response_completed') return;
    if (state.streamingText) {
        output.write('\n');
        state.streamingText = false;
    } else if (chunk.finishReason !== 'tool_calls') {
        output.write(`Assistant: ${chunk.message.content}\n`);
    }
    if (chunk.finishReason !== 'tool_calls') state.finalMessage = chunk.message.content;
}

export function renderInteractiveToolSettlement(output: ChatOutput, settlement: ToolInvocationSettlement): void {
    const status = settlement.result.status === 'failed' ? 'failed' : 'completed';
    const modelOutput = settlement.modelOutput?.content;
    output.write(
        `${formatToolResultActivity(settlement.toolName, status, {
            ...(modelOutput !== undefined ? { modelOutput } : {}),
            ...(settlement.structuredOutput !== undefined
                ? { structuredOutput: settlement.structuredOutput }
                : {}),
            ...(status === 'failed'
                ? { errorMessage: settlement.result.error?.message ?? 'unknown error' }
                : {}),
        })}\n`,
    );
    if (output.isToolOutputExpanded?.() === false) return;
    if (status === 'failed') return;
    if (settlement.toolName === 'file.patch') {
        const parsed = parseFilePatchOutput(settlement.structuredOutput);
        if (parsed !== undefined) output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
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
            return;
        }
        const content = settlement.modelOutput?.content ?? '';
        if (content.includes('\n')) {
            output.write(`Command output for ${settlement.toolName}\n${content}\n`);
        }
    }
}
