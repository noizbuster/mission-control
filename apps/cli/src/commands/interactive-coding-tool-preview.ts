import type { ToolCall } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import {
    type FileWriteArgumentsPreview,
    prepareFileWriteArgumentsPreview,
} from './interactive-coding-file-write-preview';
import { formatToolCallActivity } from './interactive-coding-tool-activity';
import { renderExpandedToolPreview } from './interactive-coding-tool-preview-detail';
import { pendingToolTranscriptPart } from './interactive-coding-tool-transcript';
import {
    allocateToolTranscriptOccurrence,
    type ProviderRenderState,
    registerActiveToolTranscriptPart,
} from './interactive-coding-transcript-render-state';
import { emitTranscriptPart } from './interactive-transcript-emission';

export type ToolPreviewRenderOptions = {
    readonly state: ProviderRenderState;
    readonly workspaceRoot?: string;
};

export async function renderToolPreview(
    toolCall: ToolCall,
    output: ChatOutput,
    options: ToolPreviewRenderOptions,
): Promise<void> {
    const fileWriteArguments =
        toolCall.toolName === 'file.write' ? prepareFileWriteArgumentsPreview(toolCall.argumentsJson) : undefined;
    const activity = formatPreviewActivity(toolCall, fileWriteArguments);
    const toolBaseId = allocateToolTranscriptOccurrence(options.state, toolCall.toolCallId);
    const messageId = options.state.lastAssistantAttributionId;
    const pendingPart = pendingToolTranscriptPart(toolCall, activity, toolBaseId, messageId);
    registerActiveToolTranscriptPart(options.state, pendingPart);
    emitTranscriptPart(output, pendingPart, `${activity}\n`);
    await renderExpandedToolPreview(toolCall, {
        toolBaseId,
        fallbackVisible: output.isToolOutputExpanded?.() !== false,
        emitPart: (part, fallbackText) => {
            registerActiveToolTranscriptPart(options.state, part);
            emitTranscriptPart(output, part, fallbackText);
        },
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(fileWriteArguments !== undefined ? { fileWriteArguments } : {}),
        ...(messageId ? { messageId } : {}),
    });
}

function formatPreviewActivity(toolCall: ToolCall, fileWriteArguments: FileWriteArgumentsPreview | undefined): string {
    if (fileWriteArguments === undefined) return formatToolCallActivity(toolCall);
    switch (fileWriteArguments.kind) {
        case 'raw':
            return 'tool: file.write';
        case 'parseable':
            return formatToolCallActivity(toolCall);
        default:
            return assertNeverFileWriteArguments(fileWriteArguments);
    }
}

function assertNeverFileWriteArguments(value: never): never {
    throw new Error(`Unexpected file.write arguments preview: ${String(value)}`);
}

export function parseFilePatchOutput(value: unknown): { readonly appliedFiles: readonly string[] } | undefined {
    if (!isRecord(value) || value.kind !== 'file_patch') {
        return undefined;
    }
    const appliedFiles = value.appliedFiles;
    if (!Array.isArray(appliedFiles) || !appliedFiles.every((entry) => typeof entry === 'string')) {
        return undefined;
    }
    return { appliedFiles };
}

export function parseFileEditOutput(
    value: unknown,
): { readonly appliedFiles: readonly string[]; readonly occurrencesReplaced: number } | undefined {
    if (!isRecord(value) || value.kind !== 'file_edit') {
        return undefined;
    }
    const appliedFiles = value.appliedFiles;
    const occurrencesReplaced = value.occurrencesReplaced;
    if (
        !Array.isArray(appliedFiles) ||
        !appliedFiles.every((entry) => typeof entry === 'string') ||
        typeof occurrencesReplaced !== 'number'
    ) {
        return undefined;
    }
    return { appliedFiles, occurrencesReplaced };
}

function isRecord(value: unknown): value is {
    readonly appliedFiles?: unknown;
    readonly kind?: unknown;
    readonly occurrencesReplaced?: unknown;
} {
    return typeof value === 'object' && value !== null;
}
