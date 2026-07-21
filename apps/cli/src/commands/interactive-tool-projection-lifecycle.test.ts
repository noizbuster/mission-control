import type { ToolInvocationSettlement } from '@mission-control/core';
import { ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';

type TranscriptWrite = {
    readonly part: TranscriptPart;
    readonly fallbackText: string;
};

function createRecording(): { readonly output: ChatOutput; readonly writes: TranscriptWrite[] } {
    const writes: TranscriptWrite[] = [];
    return {
        output: {
            write: () => undefined,
            writeTranscriptPart: (part, fallbackText) => writes.push({ part, fallbackText }),
        },
        writes,
    };
}

describe('active typed tool projection lifecycle', () => {
    it('registers provider base and preview metadata, then retires both on denied failure', async () => {
        // Given
        const recording = createRecording();
        const state = createProviderRenderState('provider/denied');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'command-denied',
            toolName: 'command.run',
            argumentsJson: JSON.stringify({ command: 'pnpm', args: ['test'] }),
        });
        const deniedSettlement = {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            result: ToolResultSchema.parse({
                toolCallId: toolCall.toolCallId,
                status: 'failed',
                error: {
                    code: 'tool_failed',
                    message: 'approval_denied: denied by user',
                    retryable: false,
                },
            }),
            events: [],
        } satisfies ToolInvocationSettlement;
        await renderToolPreview(toolCall, recording.output, { state });

        expect([...state.activeToolTranscriptParts.values()]).toEqual([
            expect.objectContaining({
                id: 'tool:provider%2Fdenied:command-denied:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'command-denied',
                toolName: 'command.run',
                status: 'pending',
            }),
            {
                id: 'tool:provider%2Fdenied:command-denied:occurrence:1:preview',
                type: 'command',
                toolCallId: 'command-denied',
                toolName: 'command.run',
                text: '$ pnpm test',
                title: 'Command preview for command.run',
                detail: '$ pnpm test',
                status: 'pending',
                command: 'pnpm test',
            },
        ]);

        // When
        renderInteractiveToolSettlement(recording.output, deniedSettlement, state);

        // Then
        expect(state.activeToolTranscriptParts.size).toBe(0);
        expect(recording.writes.at(-1)?.part).toEqual(
            expect.objectContaining({
                id: 'tool:provider%2Fdenied:command-denied:occurrence:1',
                type: 'command',
                status: 'failed',
                error: 'approval_denied: denied by user',
            }),
        );
    });

    it('projects failed outer task settlements over completed and running metadata in FIFO order', async () => {
        // Given
        const recording = createRecording();
        const state = createProviderRenderState('provider/failed-task');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'reused-task',
            toolName: 'task',
            argumentsJson: JSON.stringify({ agent: 'deep', assignment: 'inspect projection' }),
        });
        const metadataRows = [
            {
                status: 'completed',
                agentName: 'completed-agent',
                sessionId: 'session-completed',
                output: 'completed metadata output',
                error: 'outer completed conflict failed',
            },
            {
                status: 'running',
                agentName: 'running-agent',
                sessionId: 'session-running',
                output: 'running metadata output',
                error: 'outer running conflict failed',
            },
        ] as const;
        const settlements = metadataRows.map(
            (metadata): ToolInvocationSettlement => ({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: ToolResultSchema.parse({
                    toolCallId: toolCall.toolCallId,
                    status: 'failed',
                    error: { code: 'tool_failed', message: metadata.error, retryable: false },
                }),
                structuredOutput: metadata,
                events: [],
            }),
        );
        await renderToolPreview(toolCall, recording.output, { state });
        await renderToolPreview(toolCall, recording.output, { state });

        // When
        for (const settlement of settlements) {
            renderInteractiveToolSettlement(recording.output, settlement, state);
        }

        // Then
        expect(recording.writes.map(({ part }) => part).filter((part) => part.type === 'subagent')).toEqual([
            {
                id: 'tool:provider%2Ffailed-task:reused-task:occurrence:1',
                type: 'subagent',
                toolCallId: 'reused-task',
                text: 'completed metadata output',
                status: 'failed',
                agentName: 'completed-agent',
                sessionId: 'session-completed',
                error: 'outer completed conflict failed',
            },
            {
                id: 'tool:provider%2Ffailed-task:reused-task:occurrence:2',
                type: 'subagent',
                toolCallId: 'reused-task',
                text: 'running metadata output',
                status: 'failed',
                agentName: 'running-agent',
                sessionId: 'session-running',
                error: 'outer running conflict failed',
            },
        ]);
        expect(state.activeToolTranscriptParts.size).toBe(0);
        expect(state.pendingToolBaseIdsByRawId.size).toBe(0);
    });

    it.each([
        ['completed', 'completed'],
        ['running', 'background'],
    ] as const)('preserves nested %s metadata for a completed outer task settlement', (metadataStatus, expectedStatus) => {
        // Given
        const recording = createRecording();
        const state = createProviderRenderState(`provider/${metadataStatus}`);
        const settlement = {
            toolCallId: `task-${metadataStatus}`,
            toolName: 'task',
            result: ToolResultSchema.parse({
                toolCallId: `task-${metadataStatus}`,
                status: 'completed',
                output: `${metadataStatus} result`,
            }),
            structuredOutput: { status: metadataStatus },
            events: [],
        } satisfies ToolInvocationSettlement;

        // When
        renderInteractiveToolSettlement(recording.output, settlement, state);

        // Then
        expect(recording.writes.at(-1)?.part).toEqual(
            expect.objectContaining({ type: 'subagent', status: expectedStatus }),
        );
    });

    it('retires graph base and preview rows when the durable tool settlement completes', async () => {
        // Given
        const recording = createRecording();
        const state = createProviderRenderState('graph/completed');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'patch-completed',
            toolName: 'file.patch',
            argumentsJson: JSON.stringify({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' }),
        });
        await renderToolPreview(toolCall, recording.output, { state });
        expect([...state.activeToolTranscriptParts.keys()]).toEqual([
            'tool:graph%2Fcompleted:patch-completed:occurrence:1',
            'tool:graph%2Fcompleted:patch-completed:occurrence:1:preview',
        ]);

        // When
        renderGraphToolSettlement({
            output: recording.output,
            state,
            payload: {
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                output: 'patch applied',
                structuredOutput: { kind: 'file_patch', appliedFiles: ['a.txt'] },
            },
            status: 'completed',
        });

        // Then
        expect(state.activeToolTranscriptParts.size).toBe(0);
        expect(recording.writes.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:graph%2Fcompleted:patch-completed:occurrence:1',
                type: 'block-tool',
                status: 'completed',
            }),
        );
    });
});
