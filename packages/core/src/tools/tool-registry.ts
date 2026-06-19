import { type AgentEvent, type ProtocolError, ToolDefinitionSchema, ToolResultSchema } from '@mission-control/protocol';
import {
    type ParsedToolOutput,
    type RegisteredTool,
    type ToolAdvertisement,
    type ToolExecutionContext,
    ToolExecutionError,
    type ToolInvocationInput,
    type ToolInvocationSettlement,
    type ToolModelOutput,
    type ToolRegistration,
    type ToolRegistrationMetadata,
    ToolRegistrationMetadataSchema,
} from './tool-registry-types.js';
import { completedToolEvent, failedToolEvent } from './tool-settlement-events.js';
import { createHash } from 'node:crypto';

const neverAbortSignal = new AbortController().signal;

export type {
    ToolAdvertisement,
    ToolExecutionContext,
    ToolInvocationInput,
    ToolInvocationSettlement,
    ToolModelOutput,
    ToolOutputLimit,
    ToolRegistration,
} from './tool-registry-types.js';
export { ToolExecutionError } from './tool-registry-types.js';

export class ToolRegistry {
    private readonly registrations = new Map<string, RegisteredTool>();

    register<Input, Output>(registration: ToolRegistration<Input, Output>): ToolAdvertisement {
        const metadata = ToolRegistrationMetadataSchema.parse({
            name: registration.name,
            description: registration.description,
            capabilityClasses: registration.capabilityClasses,
            parametersJsonSchema: registration.parametersJsonSchema,
            outputLimit: registration.outputLimit,
            ...(registration.guideline !== undefined ? { guideline: registration.guideline } : {}),
        });
        const providerTool = ToolDefinitionSchema.parse({
            name: metadata.name,
            description: metadata.description,
            parametersJsonSchema: metadata.parametersJsonSchema,
        });
        const advertisement: ToolAdvertisement = {
            name: metadata.name,
            description: metadata.description,
            capabilityClasses: metadata.capabilityClasses,
            version: versionHashFor(metadata),
            outputLimit: metadata.outputLimit,
            providerTool,
            ...(metadata.guideline !== undefined ? { guideline: metadata.guideline } : {}),
        };
        this.registrations.set(metadata.name, {
            advertisement,
            invoke: (value, context) => invokeRegistration(registration, value, context),
        });
        return advertisement;
    }

    advertise(): readonly ToolAdvertisement[] {
        return [...this.registrations.values()].map((entry) => entry.advertisement);
    }

    /**
     * Return a NEW registry containing the entries whose advertisement passes `predicate`.
     * Copies the already-erased `RegisteredTool` entries directly (no re-validation), so a
     * heterogeneous parent surface can be filtered without re-asserting each registration's
     * Input/Output generics. Used by the subagent child-policy to drop the `task` tool +
     * destructive capabilities at the registry layer (ABG §10.6 recursion guard).
     */
    cloneWithFilter(predicate: (advertisement: ToolAdvertisement) => boolean): ToolRegistry {
        const child = new ToolRegistry();
        for (const [name, entry] of this.registrations) {
            if (predicate(entry.advertisement)) {
                child.registrations.set(name, entry);
            }
        }
        return child;
    }

    async invoke(input: ToolInvocationInput): Promise<ToolInvocationSettlement> {
        const registered = this.registrations.get(input.toolName);
        if (registered === undefined) {
            return failedSettlement(input, protocolError('tool_failed', `unknown tool: ${input.toolName}`));
        }
        if (registered.advertisement.version !== input.advertisedVersion) {
            return failedSettlement(input, protocolError('tool_failed', `stale tool call rejected: ${input.toolName}`));
        }

        const parsedArguments = parseArgumentsJson(input);
        if (!parsedArguments.ok) {
            return failedSettlement(input, parsedArguments.error);
        }
        return invokeRegisteredTool(registered, input, parsedArguments.value);
    }
}

async function invokeRegisteredTool(
    registered: RegisteredTool,
    input: ToolInvocationInput,
    parsedArguments: unknown,
): Promise<ToolInvocationSettlement> {
    const parsedOutput = await invokeWithTypedFailure(registered, input, parsedArguments);
    if (!parsedOutput.ok) {
        return failedSettlement(input, parsedOutput.error, parsedOutput.events);
    }
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
        });
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
            return { ok: false, error: error.error, events: error.events };
        }
        throw error;
    }
}

async function invokeRegistration<Input, Output>(
    registration: ToolRegistration<Input, Output>,
    value: unknown,
    context: ToolExecutionContext,
): Promise<ParsedToolOutput> {
    const parsedInput = registration.inputSchema.safeParse(value);
    if (!parsedInput.success) {
        return { ok: false, error: protocolError('schema_invalid', parsedInput.error.message), events: [] };
    }
    const output = await registration.execute(parsedInput.data, context);
    return parseOutputValue(registration, output, context);
}

type ParsedArgumentsJson =
    | {
          readonly ok: true;
          readonly value: unknown;
      }
    | {
          readonly ok: false;
          readonly error: ProtocolError;
      };

function parseArgumentsJson(input: ToolInvocationInput): ParsedArgumentsJson {
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(input.argumentsJson);
    } catch (error: unknown) {
        return { ok: false, error: protocolError('schema_invalid', errorMessage(error)) };
    }
    return { ok: true, value: parsedJson };
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
    if (registration.toModelOutput !== undefined) {
        return registration.toModelOutput(output);
    }
    if (typeof output === 'string') {
        return output;
    }
    return stableJson(output);
}

function boundModelOutput(content: string, limit: number): ToolModelOutput {
    if (content.length <= limit) {
        return {
            content,
            truncated: false,
            originalLength: content.length,
            limit,
        };
    }
    const marker = '...';
    const sliceLimit = Math.max(0, limit - marker.length);
    return {
        content: `${content.slice(0, sliceLimit)}${marker.slice(0, limit)}`,
        truncated: true,
        originalLength: content.length,
        limit,
    };
}

function failedSettlement(
    input: ToolInvocationInput,
    error: ProtocolError,
    events: readonly AgentEvent[] = [],
): ToolInvocationSettlement {
    const result = ToolResultSchema.parse({
        toolCallId: input.toolCallId,
        status: 'failed',
        error,
    });
    return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        result,
        events: [...events, failedToolEvent(input.toolCallId, input.toolName, result)],
    };
}

function protocolError(code: ProtocolError['code'], message: string): ProtocolError {
    return {
        code,
        message,
        retryable: false,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function versionHashFor(metadata: ToolRegistrationMetadata): string {
    return createHash('sha256').update(stableJson(metadata)).digest('hex');
}

function stableJson(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
