import { redactCredentialText } from '@mission-control/core';
import type { ToolCall } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io.js';

export function renderToolPreview(toolCall: ToolCall, output: ChatOutput): void {
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

function isRecord(value: unknown): value is PreviewRecord {
    return typeof value === 'object' && value !== null;
}

function redactPreviewText(text: string): string {
    return redactCredentialText(text, []);
}

type PreviewRecord = {
    readonly kind?: unknown;
    readonly appliedFiles?: unknown;
    readonly patch?: unknown;
    readonly command?: unknown;
    readonly args?: unknown;
};
