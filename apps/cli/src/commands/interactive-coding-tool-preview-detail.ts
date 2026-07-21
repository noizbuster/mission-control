import { redactCredentialText } from '@mission-control/core';
import type { ToolCall } from '@mission-control/protocol';
import type { CommandTranscriptPart, DiffTranscriptPart } from '@mission-control/tui/state';
import {
    boundFileWriteDisplayBody,
    buildFileWritePreview,
    type FileWriteArgumentsPreview,
    parseFileWritePreviewValue,
    prepareFileWriteArgumentsPreview,
    renderFileWritePreview,
    renderRawFileWriteArguments,
} from './interactive-coding-file-write-preview';
import { patchTargetPaths } from './interactive-coding-tool-previews';

export type ExpandedToolPreviewOptions = {
    readonly toolBaseId: string;
    readonly fallbackVisible: boolean;
    readonly emitPart: (part: DiffTranscriptPart | CommandTranscriptPart, fallbackText: string) => void;
    readonly workspaceRoot?: string;
    readonly fileWriteArguments?: FileWriteArgumentsPreview;
    readonly messageId?: string;
};

export async function renderExpandedToolPreview(
    toolCall: ToolCall,
    options: ExpandedToolPreviewOptions,
): Promise<void> {
    if (toolCall.toolName === 'file.edit') {
        const parsed = parseFileEditPreview(parseJson(toolCall.argumentsJson));
        const detail = redactPreviewText(renderFileEditPreview(parsed, toolCall.argumentsJson));
        const part: DiffTranscriptPart & { readonly toolCallId: string } = {
            id: `${options.toolBaseId}:preview`,
            type: 'diff',
            toolCallId: toolCall.toolCallId,
            text: detail,
            title: 'Edit preview for file.edit',
            status: 'pending',
            ...(parsed !== undefined ? { filePath: redactPreviewText(parsed.path) } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
        };
        options.emitPart(part, options.fallbackVisible ? `Edit preview for file.edit\n${detail}\n` : '');
        return;
    }
    if (toolCall.toolName === 'file.write') {
        const argumentsPreview = options.fileWriteArguments ?? prepareFileWriteArgumentsPreview(toolCall.argumentsJson);
        switch (argumentsPreview.kind) {
            case 'raw': {
                const detail = redactPreviewText(renderRawFileWriteArguments(argumentsPreview.body));
                const part: DiffTranscriptPart & { readonly toolCallId: string } = {
                    id: `${options.toolBaseId}:preview`,
                    type: 'diff',
                    toolCallId: toolCall.toolCallId,
                    text: detail,
                    title: 'Write preview for file.write',
                    status: 'pending',
                    ...(options.messageId ? { messageId: options.messageId } : {}),
                };
                options.emitPart(part, options.fallbackVisible ? `Write preview for file.write\n${detail}\n` : '');
                return;
            }
            case 'parseable':
                break;
            default:
                return assertNeverFileWriteArguments(argumentsPreview);
        }
        const parsed = parseFileWritePreviewValue(parseJson(toolCall.argumentsJson));
        const preview = parsed === undefined ? undefined : await buildFileWritePreview(parsed, options.workspaceRoot);
        const title =
            preview?.operation === 'replaced' ? 'Replace' : preview?.operation === 'created' ? 'Create' : 'Write';
        const fallback =
            parsed === undefined ? boundFileWriteDisplayBody(toolCall.argumentsJson) : parsed.proposedContent;
        const detail = redactPreviewText(renderFileWritePreview(preview, fallback));
        const part: DiffTranscriptPart & { readonly toolCallId: string } = {
            id: `${options.toolBaseId}:preview`,
            type: 'diff',
            toolCallId: toolCall.toolCallId,
            text: detail,
            title: `${title} preview for file.write`,
            status: 'pending',
            ...(parsed !== undefined ? { filePath: redactPreviewText(parsed.path) } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
        };
        options.emitPart(part, options.fallbackVisible ? `${title} preview for file.write\n${detail}\n` : '');
        return;
    }
    if (toolCall.toolName === 'file.patch') {
        const parsed = parseFilePatchPreview(parseJson(toolCall.argumentsJson));
        const detail = redactPreviewText(parsed?.patch ?? toolCall.argumentsJson);
        const paths = parsed === undefined ? [] : patchTargetPaths(parsed.patch);
        const part: DiffTranscriptPart & { readonly toolCallId: string } = {
            id: `${options.toolBaseId}:preview`,
            type: 'diff',
            toolCallId: toolCall.toolCallId,
            text: detail,
            title: 'Patch preview for file.patch',
            status: 'pending',
            ...(paths.length === 1 && paths[0] !== undefined ? { filePath: redactPreviewText(paths[0]) } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
        };
        options.emitPart(part, options.fallbackVisible ? `Patch preview for file.patch\n${detail}\n` : '');
        return;
    }
    if (toolCall.toolName === 'command.run') {
        const parsed = parseCommandRunPreview(parseJson(toolCall.argumentsJson));
        const preview =
            parsed !== undefined ? `$ ${[parsed.command, ...parsed.args].join(' ')}` : toolCall.argumentsJson;
        const detail = redactPreviewText(preview);
        const part: CommandTranscriptPart & { readonly toolCallId: string } = {
            id: `${options.toolBaseId}:preview`,
            type: 'command',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            text: detail,
            title: 'Command preview for command.run',
            detail,
            status: 'pending',
            ...(parsed !== undefined ? { command: redactPreviewText([parsed.command, ...parsed.args].join(' ')) } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
        };
        options.emitPart(part, options.fallbackVisible ? `Command preview for command.run\n${detail}\n` : '');
        return;
    }
    if (toolCall.toolName === 'bash.run') {
        const parsed = parseBashRunPreview(parseJson(toolCall.argumentsJson));
        const preview =
            parsed !== undefined
                ? `${parsed.cwd !== undefined ? `(cd ${parsed.cwd} && ` : ''}${parsed.commandLine}${
                      parsed.cwd !== undefined ? ')' : ''
                  }`
                : toolCall.argumentsJson;
        const detail = redactPreviewText(preview);
        const part: CommandTranscriptPart & { readonly toolCallId: string } = {
            id: `${options.toolBaseId}:preview`,
            type: 'command',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            text: detail,
            title: 'Command preview for bash.run',
            detail,
            status: 'pending',
            ...(parsed !== undefined ? { command: redactPreviewText(parsed.commandLine) } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
        };
        options.emitPart(part, options.fallbackVisible ? `Command preview for bash.run\n${detail}\n` : '');
    }
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) return value;
        throw error;
    }
}

function parseFilePatchPreview(value: unknown): { readonly patch: string } | undefined {
    if (!isRecord(value) || typeof value.patch !== 'string' || value.patch.length === 0) return undefined;
    return { patch: value.patch };
}

function parseFileEditPreview(value: unknown): FileEditPreview | undefined {
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.oldText !== 'string' ||
        value.oldText.length === 0 ||
        typeof value.newText !== 'string'
    ) {
        return undefined;
    }
    if (
        value.occurrence !== undefined &&
        (typeof value.occurrence !== 'number' || !Number.isInteger(value.occurrence) || value.occurrence < 1)
    ) {
        return undefined;
    }
    if (value.replaceAll !== undefined && typeof value.replaceAll !== 'boolean') return undefined;
    if (value.occurrence !== undefined && value.replaceAll !== undefined) return undefined;
    return {
        path: value.path,
        oldText: value.oldText,
        newText: value.newText,
        ...(typeof value.occurrence === 'number' ? { occurrence: value.occurrence } : {}),
        ...(typeof value.replaceAll === 'boolean' ? { replaceAll: value.replaceAll } : {}),
    };
}

function parseCommandRunPreview(
    value: unknown,
): { readonly command: string; readonly args: readonly string[] } | undefined {
    if (!isRecord(value) || typeof value.command !== 'string' || value.command.length === 0) return undefined;
    const args = value.args;
    if (args === undefined) return { command: value.command, args: [] };
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) return undefined;
    return { command: value.command, args };
}

function parseBashRunPreview(value: unknown): { readonly commandLine: string; readonly cwd?: string } | undefined {
    if (!isRecord(value) || typeof value.commandLine !== 'string' || value.commandLine.length === 0) return undefined;
    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) return undefined;
    return {
        commandLine: value.commandLine,
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    };
}

function renderFileEditPreview(parsed: FileEditPreview | undefined, fallback: string): string {
    if (parsed === undefined) return fallback;
    const selection =
        parsed.replaceAll === true
            ? 'all exact matches'
            : parsed.occurrence !== undefined
              ? `occurrence ${parsed.occurrence}`
              : 'unique exact match';
    return [
        `Target: ${parsed.path} (${selection})`,
        `--- a/${parsed.path}`,
        `+++ b/${parsed.path}`,
        ...prefixedLines('-', parsed.oldText),
        ...prefixedLines('+', parsed.newText),
    ].join('\n');
}

function prefixedLines(prefix: string, text: string): readonly string[] {
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    return normalized.split('\n').map((line) => `${prefix}${line}`);
}

function isRecord(value: unknown): value is PreviewRecord {
    return typeof value === 'object' && value !== null;
}

function redactPreviewText(text: string): string {
    return redactCredentialText(text, []);
}

function assertNeverFileWriteArguments(value: never): never {
    throw new Error(`Unexpected file.write arguments preview: ${String(value)}`);
}

type FileEditPreview = {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly occurrence?: number;
    readonly replaceAll?: boolean;
};

type PreviewRecord = {
    readonly args?: unknown;
    readonly command?: unknown;
    readonly commandLine?: unknown;
    readonly cwd?: unknown;
    readonly newText?: unknown;
    readonly occurrence?: unknown;
    readonly oldText?: unknown;
    readonly patch?: unknown;
    readonly path?: unknown;
    readonly replaceAll?: unknown;
};
