import type { AbgSignal, ToolCall } from '@mission-control/protocol';

export function readDeltaFromSignal(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.text.delta') return undefined;
    return readStringField(signal.event.payload, 'delta');
}

export function readReasoningDeltaFromSignal(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.reasoning.delta') return undefined;
    return readStringField(signal.event.payload, 'delta');
}

export function extractSignalError(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const message = Reflect.get(error, 'message');
        if (message !== undefined) return typeof message === 'string' ? message : String(message);
    }
    return typeof error === 'string' ? error : String(error ?? 'unknown error');
}

export function readToolCallProposal(signal: AbgSignal): ToolCall | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.tool_call.proposed') return undefined;
    const payload = signal.event.payload;
    if (!isToolCallProposalPayload(payload)) return undefined;
    const { toolCallId, toolName, input } = payload;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;
    if (typeof toolName !== 'string' || toolName.length === 0) return undefined;
    if (input === null || typeof input !== 'object') return undefined;
    return { toolCallId, toolName, argumentsJson: JSON.stringify(input) };
}

export function readStringField(payload: unknown, field: string): string | undefined {
    if (!isPlainObject(payload)) return undefined;
    const value = payload[field];
    return typeof value === 'string' ? value : undefined;
}

export function readErrorMessage(payload: unknown): string | undefined {
    if (!isErrorPayload(payload)) return undefined;
    return typeof payload.error === 'string' ? payload.error : readStringField(payload.error, 'message');
}

export function structuredToolOutput(payload: unknown): unknown {
    if (!isStructuredOutputPayload(payload)) return tryParseStructuredOutput(readStringField(payload, 'output'));
    return isPlainObject(payload.structuredOutput)
        ? payload.structuredOutput
        : tryParseStructuredOutput(readStringField(payload, 'output'));
}

export function parseCommandRunStatus(value: unknown): 'completed' | 'failed' | undefined {
    if (!isCommandRunPayload(value)) return undefined;
    return value.status === 'completed' || value.status === 'failed' ? value.status : undefined;
}

export function formatToolCountSummary(names: readonly string[]): string {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const name of names) {
        const current = counts.get(name);
        if (current === undefined) {
            counts.set(name, 1);
            order.push(name);
        } else {
            counts.set(name, current + 1);
        }
    }
    const entries = order.map((name) => {
        const count = counts.get(name) ?? 1;
        return count === 1 ? name : `${name} ×${count}`;
    });
    if (entries.length <= 5) return entries.join(', ');
    return `${entries.slice(0, 5).join(', ')}, +${entries.length - 5} more`;
}

function tryParseStructuredOutput(modelOutput: string | undefined): unknown {
    if (modelOutput === undefined) return undefined;
    try {
        return JSON.parse(modelOutput);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolCallProposalPayload(value: unknown): value is {
    readonly input: unknown;
    readonly toolCallId: unknown;
    readonly toolName: unknown;
} {
    return isPlainObject(value) && 'input' in value && 'toolCallId' in value && 'toolName' in value;
}

function isErrorPayload(value: unknown): value is { readonly error: unknown } {
    return isPlainObject(value) && 'error' in value;
}

function isStructuredOutputPayload(value: unknown): value is { readonly structuredOutput: unknown } {
    return isPlainObject(value) && 'structuredOutput' in value;
}

function isCommandRunPayload(value: unknown): value is { readonly kind?: unknown; readonly status?: unknown } {
    return typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'command_run';
}
