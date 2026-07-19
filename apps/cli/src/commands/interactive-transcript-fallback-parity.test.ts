import type { ToolInvocationSettlement } from '@mission-control/core';
import { AgentEventSchema, ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import { renderInteractiveToolSettlement, renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { providerEnvelope } from './interactive-transcript-emission-test-support';

const timestamp = '2026-07-17T00:00:00.000Z';

describe('plain ChatOutput fallback parity', () => {
    it('preserves each renderer fallback byte-for-byte without duplicate output', async () => {
        // Given
        const provider = createPlainOutput();
        const graph = createPlainOutput();
        const preview = createPlainOutput();
        const settlement = createPlainOutput();
        const state = createProviderRenderState('outer-emission');
        const graphError = AgentEventSchema.parse({
            type: 'model.call.failed',
            timestamp,
            abg: {
                nodeId: 'plain-error',
                emit: { type: 'llm.error', payload: { error: 'provider rejected sk-plainerror123' } },
            },
        });
        const previewCall = ToolCallSchema.parse({
            toolCallId: 'call-plain-preview',
            toolName: 'repo.read',
            argumentsJson: JSON.stringify({ path: 'README.md' }),
        });
        const failedSettlement = {
            toolCallId: 'call-plain-failed',
            toolName: 'repo.read',
            result: ToolResultSchema.parse({
                toolCallId: 'call-plain-failed',
                status: 'failed',
                error: { code: 'tool_failed', message: 'provider rejected sk-plaintool123', retryable: false },
            }),
            events: [],
        } satisfies ToolInvocationSettlement;

        // When
        renderProviderEnvelope(
            provider.output,
            state,
            providerEnvelope({
                kind: 'text_delta',
                requestId: 'request-plain',
                sequence: 1,
                delta: 'plain answer',
            }),
        );
        renderProviderEnvelope(
            provider.output,
            state,
            providerEnvelope({
                kind: 'response_completed',
                requestId: 'request-plain',
                sequence: 2,
                message: { messageId: 'message-plain', role: 'assistant', content: 'plain answer' },
                finishReason: 'stop',
            }),
        );
        renderProviderEnvelope(
            provider.output,
            state,
            providerEnvelope({
                kind: 'reasoning_completed',
                requestId: 'request-plain-reasoning',
                sequence: 1,
                text: 'hidden reasoning',
            }),
        );
        renderInteractiveGraphDurableEvent(graph.output, createProviderRenderState('outer-emission'), graphError);
        await renderToolPreview(previewCall, preview.output, { state });
        renderInteractiveToolSettlement(settlement.output, failedSettlement, state);

        // Then
        expect({
            provider: provider.writes.join(''),
            graph: graph.writes,
            preview: preview.writes,
            settlement: settlement.writes,
        }).toEqual({
            provider: 'Assistant: plain answer\n',
            graph: ['Error: provider rejected [REDACTED_CREDENTIAL]\n'],
            preview: ['tool: repo.read README.md\n'],
            settlement: ['repo.read failed: provider rejected [REDACTED_CREDENTIAL]\n'],
        });
    });
});

function createPlainOutput(): { readonly output: ChatOutput; readonly writes: string[] } {
    const writes: string[] = [];
    return { output: { write: (text) => writes.push(text) }, writes };
}
