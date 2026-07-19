import { ToolCallSchema } from '@mission-control/protocol';
import { createChatStore, type TranscriptPart } from '@mission-control/tui/state';
import { createStoreChatOutput } from './chat-agent-runner';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { completedSettlement } from './interactive-transcript-emission-test-support';

const rawToolCallId = 'gemini_call_0:0';

export const sequentialReusedToolOccurrenceExpectation = [
    {
        id: 'tool:gemini%2Fsequential:gemini_call_0%3A0:occurrence:1',
        toolCallId: rawToolCallId,
        status: 'completed',
        output: 'first contents',
    },
    {
        id: 'tool:gemini%2Fsequential:gemini_call_0%3A0:occurrence:2',
        toolCallId: rawToolCallId,
        status: 'completed',
        output: 'second contents',
    },
] as const;

export async function renderSequentialReusedToolOccurrences(): Promise<readonly TranscriptPart[]> {
    const store = createChatStore();
    const output = createStoreChatOutput(store);
    const state = createProviderRenderState('gemini/sequential');
    const toolCall = ToolCallSchema.parse({
        toolCallId: rawToolCallId,
        toolName: 'repo.read',
        argumentsJson: JSON.stringify({ path: 'README.md' }),
    });
    await renderToolPreview(toolCall, output, { state });
    renderInteractiveToolSettlement(
        output,
        completedSettlement({
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            modelOutput: 'first contents',
        }),
        state,
    );
    await renderToolPreview(toolCall, output, { state });
    renderInteractiveToolSettlement(
        output,
        completedSettlement({
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            modelOutput: 'second contents',
        }),
        state,
    );
    return store.getSnapshot().transcriptParts;
}

export async function renderConcurrentReusedToolOccurrences(): Promise<readonly TranscriptPart[]> {
    const store = createChatStore();
    const output = createStoreChatOutput(store);
    const state = createProviderRenderState('gemini/concurrent');
    const toolCall = ToolCallSchema.parse({
        toolCallId: rawToolCallId,
        toolName: 'file.patch',
        argumentsJson: JSON.stringify({ patch: filePatch }),
    });
    await renderToolPreview(toolCall, output, { state });
    await renderToolPreview(toolCall, output, { state });
    renderInteractiveToolSettlement(
        output,
        completedSettlement({
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            modelOutput: 'provider patch applied',
            structuredOutput: filePatchOutput,
        }),
        state,
    );
    renderGraphToolSettlement({
        output,
        state,
        payload: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: 'graph patch applied',
            structuredOutput: filePatchOutput,
        },
        status: 'completed',
    });
    return store.getSnapshot().transcriptParts;
}

const filePatchOutput = {
    kind: 'file_patch',
    appliedFiles: ['notes.txt'],
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
} as const;

const filePatch = [
    'diff --git a/notes.txt b/notes.txt',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    '',
].join('\n');
