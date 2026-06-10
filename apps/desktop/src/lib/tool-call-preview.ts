import type { AgentEvent, ApprovalRecord, ToolCall } from '@mission-control/protocol';
import { redactDisplayText } from './redaction.js';

export type ToolCallPreview = {
    readonly summary: string;
    readonly body: string;
};

export function approvalPreviewForRecord(
    record: ApprovalRecord,
    events: readonly AgentEvent[],
): ToolCallPreview | undefined {
    const toolCall = findToolCall(record, events);
    if (toolCall === undefined) {
        return undefined;
    }
    const parsed = parseJson(toolCall.argumentsJson);
    switch (toolCall.toolName) {
        case 'file.patch':
            return patchPreview(parsed, toolCall.argumentsJson);
        case 'command.run':
            return commandPreview(parsed, toolCall.argumentsJson);
        default:
            return {
                summary: redactDisplayText(toolCall.toolName),
                body: redactDisplayText(toolCall.argumentsJson),
            };
    }
}

function findToolCall(record: ApprovalRecord, events: readonly AgentEvent[]): ToolCall | undefined {
    const toolCallId = record.requestId.startsWith('permission_')
        ? record.requestId.slice('permission_'.length)
        : undefined;
    if (toolCallId === undefined) {
        return undefined;
    }
    for (const event of [...events].reverse()) {
        const chunk = event.providerStreamChunk;
        if (chunk?.kind === 'tool_call_completed' && chunk.toolCall.toolCallId === toolCallId) {
            return chunk.toolCall;
        }
    }
    return undefined;
}

function patchPreview(value: unknown, fallback: string): ToolCallPreview {
    if (!isRecord(value) || typeof value.patch !== 'string') {
        return { summary: 'file.patch', body: redactDisplayText(fallback) };
    }
    return {
        summary: 'file.patch',
        body: redactDisplayText(value.patch),
    };
}

function commandPreview(value: unknown, fallback: string): ToolCallPreview {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return { summary: 'command.run', body: redactDisplayText(fallback) };
    }
    const args = Array.isArray(value.args) && value.args.every((entry) => typeof entry === 'string') ? value.args : [];
    return {
        summary: 'command.run',
        body: redactDisplayText([value.command, ...args].join(' ')),
    };
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

function isRecord(value: unknown): value is PreviewRecord {
    return typeof value === 'object' && value !== null;
}

type PreviewRecord = {
    readonly patch?: unknown;
    readonly command?: unknown;
    readonly args?: unknown;
};
