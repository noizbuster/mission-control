import type { AgentEvent, ProtocolError, ToolDefinition, ToolResult } from '@mission-control/protocol';
import { z } from 'zod';

export const ToolRegistrationMetadataSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().min(1),
        capabilityClasses: z.array(z.string().min(1)).min(1),
        parametersJsonSchema: z.record(z.string(), z.unknown()),
        outputLimit: z
            .object({
                maxModelOutputChars: z.number().int().positive(),
            })
            .strict(),
        // Load-bearing: keep `.optional()` with NO `.default()`. An absent guideline must stay
        // absent in the parsed object so versionHashFor (stableJson/Object.entries) is unchanged
        // for pre-existing tools — otherwise persisted advertisedVersions break. See hash-stability.
        guideline: z.string().optional(),
    })
    .strict();

export type ToolRegistrationMetadata = z.infer<typeof ToolRegistrationMetadataSchema>;

export class ToolExecutionError extends Error {
    readonly error: ProtocolError;
    readonly events: readonly AgentEvent[];

    constructor(error: ProtocolError, events: readonly AgentEvent[] = []) {
        super(error.message);
        this.name = 'ToolExecutionError';
        this.error = error;
        this.events = events;
    }
}

export type ToolOutputLimit = {
    readonly maxModelOutputChars: number;
};

export type ToolRegistration<Input, Output> = {
    readonly name: string;
    readonly description: string;
    readonly capabilityClasses: readonly string[];
    readonly parametersJsonSchema: Readonly<Record<string, unknown>>;
    readonly inputSchema: z.ZodType<Input>;
    readonly outputSchema: z.ZodType<Output>;
    readonly outputLimit: ToolOutputLimit;
    readonly execute: (input: Input, context: ToolExecutionContext) => Output | Promise<Output>;
    readonly toModelOutput?: (output: Output) => string;
    readonly toEvents?: (output: Output, context: ToolExecutionContext) => readonly AgentEvent[];
    readonly guideline?: string;
};

export type ToolExecutionContext = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly signal: AbortSignal;
};

export type ToolAdvertisement = {
    readonly name: string;
    readonly description: string;
    readonly capabilityClasses: readonly string[];
    readonly version: string;
    readonly outputLimit: ToolOutputLimit;
    readonly providerTool: ToolDefinition;
    readonly guideline?: string;
};

export type ToolInvocationInput = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly advertisedVersion: string;
    readonly argumentsJson: string;
    readonly signal?: AbortSignal;
};

export type ToolModelOutput = {
    readonly content: string;
    readonly truncated: boolean;
    readonly originalLength: number;
    readonly limit: number;
};

export type ToolInvocationSettlement = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly result: ToolResult;
    readonly structuredOutput?: unknown;
    readonly modelOutput?: ToolModelOutput;
    readonly events: readonly AgentEvent[];
};

export type ParsedToolOutput =
    | {
          readonly ok: true;
          readonly value: unknown;
          readonly modelOutput: string;
          readonly events: readonly AgentEvent[];
      }
    | {
          readonly ok: false;
          readonly error: ProtocolError;
          readonly events: readonly AgentEvent[];
      };

export type RegisteredTool = {
    readonly advertisement: ToolAdvertisement;
    readonly invoke: (value: unknown, context: ToolExecutionContext) => Promise<ParsedToolOutput>;
};
