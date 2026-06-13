import { redactCredentialText } from '@mission-control/core';
import type { ToolCall } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io.js';
import {
    buildFileWritePreview,
    parseFileWritePreviewValue,
    renderFileWritePreview,
} from './interactive-coding-file-write-preview.js';

export async function renderToolPreview(toolCall: ToolCall, output: ChatOutput, workspaceRoot?: string): Promise<void> {
    if (toolCall.toolName === 'file.edit') {
        const parsed = parseFileEditPreview(parseJson(toolCall.argumentsJson));
        output.write('Edit preview for file.edit\n');
        output.write(`${redactPreviewText(renderFileEditPreview(parsed, toolCall.argumentsJson))}\n`);
        return;
    }
    if (toolCall.toolName === 'file.write') {
        const parsed = parseFileWritePreviewValue(parseJson(toolCall.argumentsJson));
        const preview = parsed === undefined ? undefined : await buildFileWritePreview(parsed, workspaceRoot);
        const title =
            preview?.operation === 'replaced' ? 'Replace' : preview?.operation === 'created' ? 'Create' : 'Write';
        output.write(`${title} preview for file.write\n`);
        output.write(`${redactPreviewText(renderFileWritePreview(preview, toolCall.argumentsJson))}\n`);
        return;
    }
    if (toolCall.toolName === 'file.patch') {
        const parsed = parseFilePatchPreview(parseJson(toolCall.argumentsJson));
        output.write('Patch preview for file.patch\n');
        output.write(`${redactPreviewText(parsed?.patch ?? toolCall.argumentsJson)}\n`);
        return;
    }
    if (toolCall.toolName === 'command.run') {
        const parsed = parseCommandRunPreview(parseJson(toolCall.argumentsJson));
        output.write('Command preview for command.run\n');
        const preview =
            parsed !== undefined ? `$ ${[parsed.command, ...parsed.args].join(' ')}` : toolCall.argumentsJson;
        output.write(`${redactPreviewText(preview)}\n`);
        return;
    }
    if (toolCall.toolName === 'bash.run') {
        const parsed = parseBashRunPreview(parseJson(toolCall.argumentsJson));
        output.write('Command preview for bash.run\n');
        const preview =
            parsed !== undefined
                ? `${parsed.cwd !== undefined ? `(cd ${parsed.cwd} && ` : ''}${parsed.commandLine}${
                      parsed.cwd !== undefined ? ')' : ''
                  }`
                : toolCall.argumentsJson;
        output.write(`${redactPreviewText(preview)}\n`);
    }
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

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            return value;
        }
        throw error;
    }
}

function parseFilePatchPreview(value: unknown): { readonly patch: string } | undefined {
    if (!isRecord(value) || typeof value.patch !== 'string' || value.patch.length === 0) {
        return undefined;
    }
    return { patch: value.patch };
}

function parseFileEditPreview(value: unknown):
    | {
          readonly path: string;
          readonly oldText: string;
          readonly newText: string;
          readonly occurrence?: number;
          readonly replaceAll?: boolean;
      }
    | undefined {
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
    if (value.replaceAll !== undefined && typeof value.replaceAll !== 'boolean') {
        return undefined;
    }
    if (value.occurrence !== undefined && value.replaceAll !== undefined) {
        return undefined;
    }
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
    if (!isRecord(value) || typeof value.command !== 'string' || value.command.length === 0) {
        return undefined;
    }
    const args = value.args;
    if (args === undefined) {
        return { command: value.command, args: [] };
    }
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) {
        return undefined;
    }
    return { command: value.command, args };
}

function parseBashRunPreview(value: unknown): { readonly commandLine: string; readonly cwd?: string } | undefined {
    if (!isRecord(value) || typeof value.commandLine !== 'string' || value.commandLine.length === 0) {
        return undefined;
    }
    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) {
        return undefined;
    }
    return {
        commandLine: value.commandLine,
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    };
}

function isRecord(value: unknown): value is PreviewRecord {
    return typeof value === 'object' && value !== null;
}

function redactPreviewText(text: string): string {
    return redactCredentialText(text, []);
}

function renderFileEditPreview(
    parsed:
        | {
              readonly path: string;
              readonly oldText: string;
              readonly newText: string;
              readonly occurrence?: number;
              readonly replaceAll?: boolean;
          }
        | undefined,
    fallback: string,
): string {
    if (parsed === undefined) {
        return fallback;
    }
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

type PreviewRecord = {
    readonly appliedFiles?: unknown;
    readonly kind?: unknown;
    readonly args?: unknown;
    readonly command?: unknown;
    readonly commandLine?: unknown;
    readonly newText?: unknown;
    readonly occurrence?: unknown;
    readonly oldText?: unknown;
    readonly occurrencesReplaced?: unknown;
    readonly patch?: unknown;
    readonly path?: unknown;
    readonly replaceAll?: unknown;
    readonly cwd?: unknown;
};
