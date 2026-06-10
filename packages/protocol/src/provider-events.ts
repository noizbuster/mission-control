import { z } from 'zod';
import { AgentMessageSchema, EventIdSchema, EventSequenceSchema } from './event-primitives.js';

export const REDACTION_CLASSIFICATIONS = ['secret', 'credential', 'path', 'command', 'model_output'] as const;
export const PROVIDER_STREAM_CHUNK_KINDS = [
    'response_started',
    'text_delta',
    'tool_call_delta',
    'tool_call_completed',
    'response_completed',
    'response_failed',
] as const;
export const TOOL_RESULT_STATUSES = ['completed', 'failed'] as const;
export const PROVIDER_FINISH_REASONS = [
    'stop',
    'length',
    'tool_calls',
    'content_filter',
    'cancelled',
    'error',
    'unknown',
] as const;
export const PROTOCOL_ERROR_CODES = [
    'provider_auth_failed',
    'provider_rate_limited',
    'provider_timeout',
    'provider_aborted',
    'provider_context_overflow',
    'tool_failed',
    'schema_invalid',
    'unknown',
] as const;

export const RedactionClassificationSchema = z.enum(REDACTION_CLASSIFICATIONS);
export type RedactionClassification = z.infer<typeof RedactionClassificationSchema>;

export const ProviderStreamChunkKindSchema = z.enum(PROVIDER_STREAM_CHUNK_KINDS);
export type ProviderStreamChunkKind = z.infer<typeof ProviderStreamChunkKindSchema>;

export const ToolResultStatusSchema = z.enum(TOOL_RESULT_STATUSES);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const ProviderFinishReasonSchema = z.enum(PROVIDER_FINISH_REASONS);
export type ProviderFinishReason = z.infer<typeof ProviderFinishReasonSchema>;

export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const RedactionMetadataSchema = z
    .object({
        classification: RedactionClassificationSchema,
        reason: z.string().min(1),
        replacement: z.string().min(1),
    })
    .strict();
export type RedactionMetadata = z.infer<typeof RedactionMetadataSchema>;

export const ProtocolErrorSchema = z
    .object({
        code: ProtocolErrorCodeSchema,
        message: z.string().min(1),
        retryable: z.boolean(),
        redactions: z.array(RedactionMetadataSchema).optional(),
    })
    .strict();
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const ToolDefinitionSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().min(1),
        parametersJsonSchema: z.record(z.string(), z.unknown()),
    })
    .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ProviderRequestSchema = z
    .object({
        requestId: z.string().min(1),
        sessionId: z.string().min(1),
        turnId: z.string().min(1),
        providerID: z.string().min(1),
        modelID: z.string().min(1),
        variantID: z.string().min(1).optional(),
        messages: z.array(AgentMessageSchema),
        tools: z.array(ToolDefinitionSchema).optional(),
    })
    .strict();
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

export const ToolCallSchema = z
    .object({
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        argumentsJson: z.string().min(1),
        providerCallId: z.string().min(1).optional(),
        providerItemId: z.string().min(1).optional(),
    })
    .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z
    .object({
        toolCallId: z.string().min(1),
        status: ToolResultStatusSchema,
        output: z.string().optional(),
        error: ProtocolErrorSchema.optional(),
        redactions: z.array(RedactionMetadataSchema).optional(),
    })
    .strict();
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ProviderUsageSchema = z
    .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
    })
    .strict();
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const ProviderMessageSchema = z
    .object({
        messageId: EventIdSchema,
        role: z.literal('assistant'),
        content: z.string(),
        toolCallIds: z.array(z.string().min(1)).optional(),
        redactions: z.array(RedactionMetadataSchema).optional(),
    })
    .strict();
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>;

export const ToolCallSettlementSchema = z
    .object({
        toolCall: ToolCallSchema,
        result: ToolResultSchema,
        finalMessage: ProviderMessageSchema,
    })
    .strict()
    .superRefine((settlement, context) => {
        if (settlement.result.toolCallId !== settlement.toolCall.toolCallId) {
            context.addIssue({
                code: 'custom',
                message: 'tool result must reference the tool call id',
                path: ['result', 'toolCallId'],
            });
        }

        if (!settlement.finalMessage.toolCallIds?.includes(settlement.toolCall.toolCallId)) {
            context.addIssue({
                code: 'custom',
                message: 'final message must reference the settled tool call id',
                path: ['finalMessage', 'toolCallIds'],
            });
        }
    });
export type ToolCallSettlement = z.infer<typeof ToolCallSettlementSchema>;

const SourceEventTypeSchema = z.string().min(1).optional();
const ProviderResponseIdSchema = z.string().min(1).optional();

export const ProviderStreamChunkSchema = z.discriminatedUnion('kind', [
    z
        .object({
            kind: z.literal('response_started'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
        })
        .strict(),
    z
        .object({
            kind: z.literal('text_delta'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
            delta: z.string(),
            redactions: z.array(RedactionMetadataSchema).optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal('tool_call_delta'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
            toolCallId: z.string().min(1),
            providerCallId: z.string().min(1).optional(),
            providerItemId: z.string().min(1).optional(),
            argumentsDelta: z.string(),
        })
        .strict(),
    z
        .object({
            kind: z.literal('tool_call_completed'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
            toolCall: ToolCallSchema,
        })
        .strict(),
    z
        .object({
            kind: z.literal('response_completed'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
            message: ProviderMessageSchema,
            finishReason: ProviderFinishReasonSchema,
            usage: ProviderUsageSchema.optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal('response_failed'),
            requestId: z.string().min(1),
            sequence: EventSequenceSchema,
            sourceEventType: SourceEventTypeSchema,
            providerResponseId: ProviderResponseIdSchema,
            error: ProtocolErrorSchema,
        })
        .strict(),
]);
export type ProviderStreamChunk = z.infer<typeof ProviderStreamChunkSchema>;
