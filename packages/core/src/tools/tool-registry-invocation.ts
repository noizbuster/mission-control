import { type AgentEvent, type ProtocolError, ToolResultSchema } from '@mission-control/protocol';
import {
    type ParsedToolOutput,
    type RegisteredTool,
    type ToolExecutionContext,
    ToolExecutionError,
    type ToolInvocationInput,
    type ToolInvocationSettlement,
    type ToolModelOutput,
    type ToolRegistration,
    type ToolRegistrationMetadata,
} from './tool-registry-types';
import { completedToolEvent, failedToolEvent } from './tool-settlement-events';
import { createHash } from 'node:crypto';

const neverAbortSignal = new AbortController().signal;

export async function commitToolSettlement(
    input: ToolInvocationInput,
    settlement: ToolInvocationSettlement,
): Promise<ToolInvocationSettlement> {
    const fence = input.controlEpoch?.callbackFence;
    if (fence === undefined) return settlement;
    if (input.writeSettlement === undefined) {
        return failedToolSettlement(
            input,
            protocolError('tool_failed', 'controlled tool settlement writer is required'),
        );
    }
    const errorCode = settlement.result.error?.code;
    const handleKind = handleKindForTool(input.toolName);
    const accepted = await fence.settle({
        handleKind,
        handleId: `${handleKind}:${input.toolCallId}`,
        attemptedEventType: settlement.result.status === 'completed' ? 'tool.completed' : 'tool.failed',
        metadata: {
            status: settlement.result.status,
            ...(errorCode !== undefined ? { errorCode } : {}),
            signalAborted: input.signal?.aborted ?? false,
        },
        write: (client) => input.writeSettlement?.(settlement, client) ?? Promise.resolve(),
    });
    return accepted.accepted
        ? settlement
        : failedToolSettlement(input, protocolError('tool_failed', 'tool callback quarantined'));
}

export async function invokeRegisteredTool(
    registered: RegisteredTool,
    input: ToolInvocationInput,
    parsedArguments: unknown,
): Promise<ToolInvocationSettlement> {
    const parsedOutput = await invokeWithTypedFailure(registered, input, parsedArguments);
    if (!parsedOutput.ok) return failedToolSettlement(input, parsedOutput.error, parsedOutput.events);
    const modelOutput = boundModelOutput(
        parsedOutput.modelOutput,
        registered.advertisement.outputLimit.maxModelOutputChars,
    );
    const result = ToolResultSchema.parse({
        toolCallId: input.toolCallId,
        status: 'completed',
        output: modelOutput.content,
    });
    return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        result,
        structuredOutput: parsedOutput.value,
        modelOutput,
        events: [...parsedOutput.events, completedToolEvent(input.toolCallId, input.toolName, result)],
    };
}

export async function invokeToolRegistration<Input, Output>(
    registration: ToolRegistration<Input, Output>,
    value: unknown,
    context: ToolExecutionContext,
): Promise<ParsedToolOutput> {
    const parsedInput = registration.inputSchema.safeParse(value);
    if (!parsedInput.success) {
        return { ok: false, error: protocolError('schema_invalid', parsedInput.error.message, true), events: [] };
    }
    const output = await registration.execute(parsedInput.data, context);
    return parseOutputValue(registration, output, context);
}

export function parseToolArgumentsJson(
    input: ToolInvocationInput,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ProtocolError } {
    try {
        return { ok: true, value: JSON.parse(input.argumentsJson) };
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            return { ok: false, error: protocolError('schema_invalid', error.message, true) };
        }
        throw error;
    }
}

export function failedToolSettlement(
    input: ToolInvocationInput,
    error: ProtocolError,
    events: readonly AgentEvent[] = [],
): ToolInvocationSettlement {
    const result = ToolResultSchema.parse({ toolCallId: input.toolCallId, status: 'failed', error });
    return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        result,
        events: [...events, failedToolEvent(input.toolCallId, input.toolName, result)],
    };
}

export function protocolError(code: ProtocolError['code'], message: string, retryable = false): ProtocolError {
    return { code, message, retryable };
}

export function versionHashFor(metadata: ToolRegistrationMetadata): string {
    return createHash('sha256').update(stableJson(metadata)).digest('hex');
}

async function invokeWithTypedFailure(
    registered: RegisteredTool,
    input: ToolInvocationInput,
    parsedArguments: unknown,
): Promise<ParsedToolOutput> {
    try {
        return await registered.invoke(parsedArguments, {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            signal: input.signal ?? neverAbortSignal,
            ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
        });
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) return { ok: false, error: error.error, events: error.events };
        throw error;
    }
}

function handleKindForTool(toolName: string): 'command' | 'shell' | 'subagent' | 'tool' {
    if (toolName === 'command.run') return 'command';
    if (toolName === 'shell.session') return 'shell';
    if (toolName === 'task') return 'subagent';
    return 'tool';
}

function parseOutputValue<Input, Output>(
    registration: ToolRegistration<Input, Output>,
    value: unknown,
    context: ToolExecutionContext,
): ParsedToolOutput {
    const parsedOutput = registration.outputSchema.safeParse(value);
    if (!parsedOutput.success) {
        return { ok: false, error: protocolError('schema_invalid', parsedOutput.error.message), events: [] };
    }
    return {
        ok: true,
        value: parsedOutput.data,
        modelOutput: modelOutputFor(registration, parsedOutput.data),
        events: registration.toEvents?.(parsedOutput.data, context) ?? [],
    };
}

function modelOutputFor<Input, Output>(registration: ToolRegistration<Input, Output>, output: Output): string {
    if (registration.toModelOutput !== undefined) return registration.toModelOutput(output);
    if (typeof output === 'string') return output;
    return stableJson(output);
}

function boundModelOutput(content: string, limit: number): ToolModelOutput {
    if (content.length <= limit) return { content, truncated: false, originalLength: content.length, limit };
    const marker = '...';
    const sliceLimit = Math.max(0, limit - marker.length);
    return {
        content: `${content.slice(0, sliceLimit)}${marker.slice(0, limit)}`,
        truncated: true,
        originalLength: content.length,
        limit,
    };
}

function stableJson(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
