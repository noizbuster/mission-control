import type { ToolInvocationSettlement } from '@mission-control/core';
import { AgentEventSchema, ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './store-chat-output';
import { renderInteractiveToolSettlement, renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { completedSettlement, providerEnvelope } from './interactive-transcript-emission-test-support';
import {
    renderConcurrentReusedToolOccurrences,
    renderSequentialReusedToolOccurrences,
    sequentialReusedToolOccurrenceExpectation,
} from './interactive-transcript-occurrence-test-support';

const timestamp = '2026-07-17T00:00:00.000Z';

describe('execution-scoped transcript identity', () => {
    it('keeps reused provider request IDs separate from user rows and other turns', () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        store.submitLine('preserve this user row');

        // When
        renderProviderEnvelope(
            output,
            createProviderRenderState('provider/one'),
            completedProviderEnvelope('submitted-user-1', 'first answer'),
        );
        renderProviderEnvelope(
            output,
            createProviderRenderState('provider/two'),
            completedProviderEnvelope('submitted-user-1', 'second answer'),
        );

        // Then
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'submitted-user-1', type: 'user', text: 'preserve this user row' },
            {
                id: 'provider:provider%2Fone:submitted-user-1:assistant',
                type: 'assistant',
                text: 'first answer',
                status: 'completed',
                messageId: 'message-first answer',
                requestId: 'submitted-user-1',
            },
            {
                id: 'provider:provider%2Ftwo:submitted-user-1:assistant',
                type: 'assistant',
                text: 'second answer',
                status: 'completed',
                messageId: 'message-second answer',
                requestId: 'submitted-user-1',
            },
        ]);
    });

    it('converges reused tool previews and settlements within each execution turn', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'submitted-user-1',
            toolName: 'repo.read',
            argumentsJson: JSON.stringify({ path: 'README.md' }),
        });
        store.submitLine('keep the colliding user identity');
        const firstState = createProviderRenderState('tool/one');
        const secondState = createProviderRenderState('tool/two');

        // When
        await renderToolPreview(toolCall, output, { state: firstState });
        renderInteractiveToolSettlement(
            output,
            completedSettlement({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                modelOutput: 'first contents',
            }),
            firstState,
        );
        await renderToolPreview(toolCall, output, { state: secondState });
        renderInteractiveToolSettlement(
            output,
            completedSettlement({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                modelOutput: 'second contents',
            }),
            secondState,
        );

        // Then
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'submitted-user-1', type: 'user', text: 'keep the colliding user identity' },
            expect.objectContaining({
                id: 'tool:tool%2Fone:submitted-user-1:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'submitted-user-1',
                status: 'completed',
                output: 'first contents',
            }),
            expect.objectContaining({
                id: 'tool:tool%2Ftwo:submitted-user-1:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'submitted-user-1',
                status: 'completed',
                output: 'second contents',
            }),
        ]);
    });

    it('retains two sequential occurrences when one provider reuses a raw tool call ID', async () => {
        // Given
        const expected = sequentialReusedToolOccurrenceExpectation;

        // When
        const parts = await renderSequentialReusedToolOccurrences();

        // Then
        expect(parts).toMatchObject(expected);
    });

    it('claims concurrently open reused previews FIFO across provider and graph settlements', async () => {
        // Given
        const rawToolCallId = 'gemini_call_0:0';

        // When
        const parts = await renderConcurrentReusedToolOccurrences();

        // Then
        expect(
            parts.map((part) => ({
                id: part.id,
                toolCallId: 'toolCallId' in part ? part.toolCallId : undefined,
                status: 'status' in part ? part.status : undefined,
            })),
        ).toEqual([
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:1',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:1:preview',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:2',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:2:preview',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:1:result:0',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
            {
                id: 'tool:gemini%2Fconcurrent:gemini_call_0%3A0:occurrence:2:result:0',
                toolCallId: rawToolCallId,
                status: 'completed',
            },
        ]);
    });

    it('derives preview and file-result IDs from the execution-scoped tool base ID', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'shared/patch',
            toolName: 'file.patch',
            argumentsJson: JSON.stringify({ patch: filePatch }),
        });
        const settlement = filePatchSettlement(toolCall.toolCallId);
        const state = createProviderRenderState('files/one');

        // When
        await renderToolPreview(toolCall, output, { state });
        renderInteractiveToolSettlement(output, settlement, state);

        // Then
        expect(
            store.getSnapshot().transcriptParts.map((part) => ({
                id: part.id,
                type: part.type,
                status: 'status' in part ? part.status : undefined,
                toolCallId: 'toolCallId' in part ? part.toolCallId : undefined,
            })),
        ).toEqual([
            {
                id: 'tool:files%2Fone:shared%2Fpatch:occurrence:1',
                type: 'block-tool',
                status: 'completed',
                toolCallId: 'shared/patch',
            },
            {
                id: 'tool:files%2Fone:shared%2Fpatch:occurrence:1:preview',
                type: 'diff',
                status: 'completed',
                toolCallId: 'shared/patch',
            },
            {
                id: 'tool:files%2Fone:shared%2Fpatch:occurrence:1:result:0',
                type: 'diff',
                status: 'completed',
                toolCallId: 'shared/patch',
            },
        ]);
    });
});

function completedProviderEnvelope(requestId: string, content: string) {
    return providerEnvelope({
        kind: 'response_completed',
        requestId,
        sequence: 1,
        message: { messageId: `message-${content}`, role: 'assistant', content },
        finishReason: 'stop',
    });
}

function filePatchSettlement(toolCallId: string): ToolInvocationSettlement {
    const result = ToolResultSchema.parse({
        toolCallId,
        status: 'completed',
        output: 'patch applied',
    });
    return {
        toolCallId,
        toolName: 'file.patch',
        result,
        structuredOutput: { kind: 'file_patch', appliedFiles: ['notes.txt'] },
        modelOutput: { content: 'patch applied', truncated: false, originalLength: 13, limit: 8_192 },
        events: [
            AgentEventSchema.parse({
                type: 'file.diff.applied',
                timestamp,
                diffFiles: [
                    {
                        filePath: 'notes.txt',
                        changeKind: 'modified',
                        hunks: [
                            {
                                oldStart: 1,
                                oldLines: 1,
                                newStart: 1,
                                newLines: 1,
                                lines: [
                                    { kind: 'removed', content: 'before' },
                                    { kind: 'added', content: 'after' },
                                ],
                            },
                        ],
                    },
                ],
            }),
        ],
    };
}

const filePatch = [
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
].join('\n');
