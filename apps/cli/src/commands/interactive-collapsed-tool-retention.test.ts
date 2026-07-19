import type { ToolInvocationSettlement } from '@mission-control/core';
import { AgentEventSchema, ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import { createChatStore, type TranscriptPart } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './chat-agent-runner';
import type { ChatOutput } from './interactive-chat-io';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';

const timestamp = '2026-07-18T00:00:00.000Z';
const executionTurnId = 'collapsed/turn';
const patchText = [
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
].join('\n');
const diffFiles = [
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
] as const;

describe('collapsed semantic tool retention', () => {
    it('retains full patch and command preview parts while fallback bytes stay compact', async () => {
        // Given
        const recording = createRecording(false);
        const patchCall = toolCall('file.patch', 'call-patch', { patch: patchText });
        const commandCall = toolCall('command.run', 'call-command', { command: 'echo', args: ['hi'] });
        const state = createProviderRenderState(executionTurnId);

        // When
        await renderToolPreview(patchCall, recording.output, { state });
        await renderToolPreview(commandCall, recording.output, { state });

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:call-patch:occurrence:1',
                type: 'inline-tool',
                status: 'pending',
            }),
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:call-patch:occurrence:1:preview',
                type: 'diff',
                text: patchText,
                status: 'pending',
            }),
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:call-command:occurrence:1',
                type: 'inline-tool',
                status: 'pending',
            }),
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:call-command:occurrence:1:preview',
                type: 'command',
                text: '$ echo hi',
                detail: '$ echo hi',
                status: 'pending',
            }),
        ]);
        expect(recording.fallbackBytes).toEqual(['tool: file.patch patch\n', '', 'tool: command.run $ echo hi\n', '']);
        expect(recording.rawWrites).toEqual([]);
    });

    it('retains provider and graph file-result parts before collapsed fallback returns', () => {
        // Given
        const provider = createRecording(false);
        const graph = createRecording(false);
        const providerState = createProviderRenderState(executionTurnId);
        const graphState = createProviderRenderState(executionTurnId);

        // When
        renderInteractiveToolSettlement(provider.output, filePatchSettlement('provider-patch'), providerState);
        renderGraphToolSettlement({
            output: graph.output,
            state: graphState,
            payload: {
                toolCallId: 'graph-patch',
                toolName: 'file.patch',
                output: 'patch applied',
                structuredOutput: { kind: 'file_patch', appliedFiles: ['notes.txt'], diffFiles },
            },
            status: 'completed',
        });

        // Then
        expect(provider.transcriptWrites.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:provider-patch:occurrence:1:result:0',
                type: 'diff',
                text: expect.stringContaining('+after'),
                status: 'completed',
            }),
        );
        expect(graph.transcriptWrites.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:graph-patch:occurrence:1:result:0',
                type: 'diff',
                text: expect.stringContaining('+after'),
                status: 'completed',
            }),
        );
        expect(provider.fallbackBytes).toEqual(['Applied patch: notes.txt\n', '']);
        expect(graph.fallbackBytes).toEqual(['Applied patch: notes.txt\n', '']);
    });

    it('converges a collapsed pending patch preview to completed without losing its body', async () => {
        // Given
        const store = createChatStore();
        store.toggleToolOutputExpanded();
        const output = createStoreChatOutput(store);
        const patchCall = toolCall('file.patch', 'shared/patch', { patch: patchText });
        const state = createProviderRenderState(executionTurnId);

        // When
        await renderToolPreview(patchCall, output, { state });
        renderInteractiveToolSettlement(output, filePatchSettlement(patchCall.toolCallId), state);

        // Then
        expect(
            store.getSnapshot().transcriptParts.map((part) => ({
                id: part.id,
                type: part.type,
                text: part.text,
                status: 'status' in part ? part.status : undefined,
            })),
        ).toEqual([
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:shared%2Fpatch:occurrence:1',
                type: 'block-tool',
                status: 'completed',
            }),
            {
                id: 'tool:collapsed%2Fturn:shared%2Fpatch:occurrence:1:preview',
                type: 'diff',
                text: patchText,
                status: 'completed',
            },
            expect.objectContaining({
                id: 'tool:collapsed%2Fturn:shared%2Fpatch:occurrence:1:result:0',
                type: 'diff',
                text: expect.stringContaining('+after'),
                status: 'completed',
            }),
        ]);
        expect(store.getOutput()).toBe('tool: file.patch patch\nApplied patch: notes.txt\n');
    });

    it('keeps collapsed plain fallback byte-exact and free of specialized detail', async () => {
        // Given
        const recording = createPlainRecording(false);
        const patchCall = toolCall('file.patch', 'plain-patch', { patch: patchText });
        const state = createProviderRenderState(executionTurnId);

        // When
        await renderToolPreview(patchCall, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, filePatchSettlement(patchCall.toolCallId), state);

        // Then
        expect(recording.writes.join('')).toBe('tool: file.patch patch\nApplied patch: notes.txt\n');
        expect(recording.writes.join('')).not.toContain('Patch preview for file.patch');
        expect(recording.writes.join('')).not.toContain('--- a/notes.txt');
    });

    it('preserves expanded preview and settlement fallback bytes exactly', async () => {
        // Given
        const recording = createPlainRecording(true);
        const patchCall = toolCall('file.patch', 'expanded-patch', { patch: patchText });
        const state = createProviderRenderState(executionTurnId);

        // When
        await renderToolPreview(patchCall, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, filePatchSettlement(patchCall.toolCallId), state);

        // Then
        expect(recording.writes.join('')).toBe(
            `tool: file.patch patch\nPatch preview for file.patch\n${patchText}\nApplied patch: notes.txt\nApplied patch: notes.txt\n`,
        );
    });
});

type TranscriptWrite = {
    readonly part: TranscriptPart;
    readonly fallbackText: string;
};

function createRecording(expanded: boolean): {
    readonly output: ChatOutput;
    readonly rawWrites: string[];
    readonly fallbackBytes: string[];
    readonly transcriptWrites: TranscriptWrite[];
} {
    const rawWrites: string[] = [];
    const fallbackBytes: string[] = [];
    const transcriptWrites: TranscriptWrite[] = [];
    return {
        output: {
            write: (text) => rawWrites.push(text),
            writeTranscriptPart: (part, fallbackText) => {
                transcriptWrites.push({ part, fallbackText });
                fallbackBytes.push(fallbackText);
            },
            writeTranscriptFallback: (text) => fallbackBytes.push(text),
            isToolOutputExpanded: () => expanded,
        },
        rawWrites,
        fallbackBytes,
        transcriptWrites,
    };
}

function createPlainRecording(expanded: boolean): { readonly output: ChatOutput; readonly writes: string[] } {
    const writes: string[] = [];
    return {
        output: { write: (text) => writes.push(text), isToolOutputExpanded: () => expanded },
        writes,
    };
}

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>) {
    return ToolCallSchema.parse({ toolCallId, toolName, argumentsJson: JSON.stringify(input) });
}

function filePatchSettlement(toolCallId: string): ToolInvocationSettlement {
    return {
        toolCallId,
        toolName: 'file.patch',
        result: ToolResultSchema.parse({ toolCallId, status: 'completed', output: 'patch applied' }),
        structuredOutput: { kind: 'file_patch', appliedFiles: ['notes.txt'] },
        modelOutput: { content: 'patch applied', truncated: false, originalLength: 13, limit: 8_192 },
        events: [AgentEventSchema.parse({ type: 'file.diff.applied', timestamp, diffFiles })],
    };
}
