import type { ToolCall } from '@mission-control/protocol';
import { createChatStore, type TranscriptPart } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStoreChatOutput } from './chat-agent-runner';
import type { ChatOutput } from './interactive-chat-io';
import {
    buildFileWritePreview,
    FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES,
    FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES,
    parseFileWritePreviewValue,
    renderFileWritePreview,
} from './interactive-coding-file-write-preview';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('bounded file.write preview retention', () => {
    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('caps proposed Hangul and emoji content at a UTF-8 boundary without retaining full content', () => {
        // Given
        const retainedHangul = '한'.repeat(Math.floor(FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES / 3));
        const content = `${retainedHangul}🙂TAIL_SENTINEL`;

        // When
        const parsed = parseFileWritePreviewValue({ path: 'unicode.txt', content });

        // Then
        expect(parsed).toEqual({
            path: 'unicode.txt',
            createParents: false,
            proposedContent: {
                text: retainedHangul,
                originalBytes: Buffer.byteLength(content),
                returnedBytes: Buffer.byteLength(retainedHangul),
                truncated: true,
            },
        });
        expect(parsed).not.toHaveProperty('content');
        expect(parsed?.proposedContent.text).not.toContain('\uFFFD');
        if (parsed === undefined) throw new Error('Expected parsed file.write preview');
        expect(renderFileWritePreview({ operation: 'created', ...parsed }, parsed.proposedContent)).toContain(
            `Proposed content: ${Buffer.byteLength(retainedHangul)}/${Buffer.byteLength(content)} bytes (truncated)`,
        );
    });

    it('reads at most 64 KiB from an existing target and omits its tail sentinel', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-bounded-existing-preview-');
        const existingPrefix = '한'.repeat(Math.floor(FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES / 3));
        const existingContent = `${existingPrefix}🙂EXISTING_TAIL_SENTINEL`;
        await writeFile(join(workspaceRoot, 'existing.txt'), existingContent, 'utf8');
        const parsed = parseFileWritePreviewValue({ path: 'existing.txt', content: 'replacement\n' });
        if (parsed === undefined) throw new Error('Expected parsed file.write preview');

        // When
        const preview = await buildFileWritePreview(parsed, workspaceRoot);

        // Then
        expect(preview).toEqual({
            operation: 'replaced',
            path: 'existing.txt',
            createParents: false,
            proposedContent: {
                text: 'replacement\n',
                originalBytes: 12,
                returnedBytes: 12,
                truncated: false,
            },
            existingContent: {
                text: existingPrefix,
                originalBytes: Buffer.byteLength(existingContent),
                returnedBytes: Buffer.byteLength(existingPrefix),
                truncated: true,
            },
        });
        expect(preview).not.toHaveProperty('originalContent');
        expect(preview.existingContent?.text).not.toContain('\uFFFD');
        expect(renderFileWritePreview(preview, parsed.proposedContent)).toContain(
            `Existing content: ${Buffer.byteLength(existingPrefix)}/${Buffer.byteLength(existingContent)} bytes (truncated)`,
        );
    });

    it('keeps oversized raw arguments bounded without JSON parsing or filesystem reads', async () => {
        // Given
        const rawTail = 'RAW_ARGUMENT_TAIL_SENTINEL';
        const argumentsJson = JSON.stringify({
            path: 'unread.txt',
            content: `${'가'.repeat(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES)}${rawTail}`,
        });
        const call = rawToolCall('oversized-raw', argumentsJson);
        const recording = createRecording(false);
        const parse = vi.spyOn(JSON, 'parse');

        // When
        await renderToolPreview(call, recording.output, {
            state: createProviderRenderState('bounded-file-write'),
            workspaceRoot: join(tmpdir(), 'missing-file-write-preview-root'),
        });

        // Then
        const preview = findPreviewPart(recording.transcriptWrites);
        expect(parse).not.toHaveBeenCalled();
        expect(preview.text).not.toContain(rawTail);
        const metadata = /^Raw arguments: (\d+)\/(\d+) bytes \(truncated\)/u.exec(preview.text);
        const returnedBytes = metadata?.[1];
        const originalBytes = metadata?.[2];
        if (returnedBytes === undefined || originalBytes === undefined) {
            throw new Error('Expected raw argument byte metadata');
        }
        expect(Number(returnedBytes)).toBeLessThanOrEqual(FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES);
        expect(Number(originalBytes)).toBe(Buffer.byteLength(argumentsJson));
        expect(recording.fallbackBytes).toEqual(['tool: file.write\n', '']);
        expect(recording.rawWrites).toEqual([]);
    });

    it('retains one parseable semantic preview while collapsed fallback stays activity plus empty detail', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-collapsed-write-preview-');
        const recording = createRecording(false);
        const call = toolCall('collapsed-write', { path: 'notes.txt', content: 'bounded body\n' });

        // When
        await renderToolPreview(call, recording.output, {
            state: createProviderRenderState('bounded-file-write'),
            workspaceRoot,
        });

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            expect.objectContaining({
                id: 'tool:bounded-file-write:collapsed-write:occurrence:1',
                type: 'inline-tool',
                text: 'tool: file.write notes.txt',
                status: 'pending',
            }),
            expect.objectContaining({
                id: 'tool:bounded-file-write:collapsed-write:occurrence:1:preview',
                type: 'diff',
                text: expect.stringContaining('+bounded body'),
                status: 'pending',
            }),
        ]);
        expect(recording.fallbackBytes).toEqual(['tool: file.write notes.txt\n', '']);
    });

    it('reuses the retained existing-file preview after the target changes and is deleted', async () => {
        // Given
        const workspaceRoot = await tempRoot('mctrl-retained-write-preview-');
        const targetPath = join(workspaceRoot, 'existing.txt');
        await writeFile(targetPath, 'ORIGINAL_BODY\n', 'utf8');
        const store = createChatStore();
        store.toggleToolOutputExpanded();
        const emitTranscriptPart = vi.spyOn(store, 'emitTranscriptPart');
        const output = createStoreChatOutput(store);
        const call = toolCall('retained-write', { path: 'existing.txt', content: 'PROPOSED_BODY\n' });
        await renderToolPreview(call, output, {
            state: createProviderRenderState('bounded-file-write'),
            workspaceRoot,
        });
        const retainedPreview = store
            .getSnapshot()
            .transcriptParts.find((part) => part.id === 'tool:bounded-file-write:retained-write:occurrence:1:preview');
        if (retainedPreview === undefined) throw new Error('Expected retained file.write preview');

        // When
        await writeFile(targetPath, 'CHANGED_AFTER_PREVIEW\n', 'utf8');
        await rm(targetPath);
        store.toggleToolOutputExpanded();

        // Then
        expect(store.getSnapshot().transcriptParts.find((part) => part.id === retainedPreview.id)).toBe(
            retainedPreview,
        );
        expect(retainedPreview.text).toContain('ORIGINAL_BODY');
        expect(retainedPreview.text).not.toContain('CHANGED_AFTER_PREVIEW');
        expect(emitTranscriptPart).toHaveBeenCalledTimes(2);
    });
});

type TranscriptWrite = { readonly part: TranscriptPart; readonly fallbackText: string };

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
            isToolOutputExpanded: () => expanded,
        },
        rawWrites,
        fallbackBytes,
        transcriptWrites,
    };
}

function findPreviewPart(writes: readonly TranscriptWrite[]): TranscriptPart {
    const preview = writes.find(({ part }) => part.id.endsWith(':preview'))?.part;
    if (preview === undefined) throw new Error('Expected semantic preview part');
    return preview;
}

function toolCall(toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return rawToolCall(toolCallId, JSON.stringify(input));
}

function rawToolCall(toolCallId: string, argumentsJson: string): ToolCall {
    return { toolCallId, toolName: 'file.write', argumentsJson };
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
