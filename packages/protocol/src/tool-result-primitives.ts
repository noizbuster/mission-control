import { z } from 'zod';

export const REDACTION_CLASSIFICATIONS = ['secret', 'credential', 'path', 'command', 'model_output'] as const;
export const TOOL_RESULT_STATUSES = ['completed', 'failed'] as const;
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

export const ToolResultStatusSchema = z.enum(TOOL_RESULT_STATUSES);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

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
