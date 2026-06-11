import { z } from 'zod';
import { ProtocolErrorSchema, RedactionMetadataSchema, ToolResultStatusSchema } from './tool-result-primitives.js';

export const EventIdSchema = z.string().min(1);
export type EventId = z.infer<typeof EventIdSchema>;

export const EventSequenceSchema = z.number().int().nonnegative();
export type EventSequence = z.infer<typeof EventSequenceSchema>;

const SystemMessageSchema = z
    .object({
        role: z.literal('system'),
        content: z.string(),
    })
    .strict();

const UserMessageSchema = z
    .object({
        role: z.literal('user'),
        content: z.string(),
    })
    .strict();

export const ProviderToolCallTranscriptSchema = z
    .object({
        providerID: z.string().min(1),
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        argumentsJson: z.string(),
        providerCallId: z.string().min(1).optional(),
        providerItemId: z.string().min(1).optional(),
    })
    .strict();
export type ProviderToolCallTranscript = z.infer<typeof ProviderToolCallTranscriptSchema>;

const AssistantMessageSchema = z
    .object({
        role: z.literal('assistant'),
        content: z.string(),
        providerToolCalls: z.array(ProviderToolCallTranscriptSchema).optional(),
    })
    .strict();

export const TextAgentMessageSchema = z.discriminatedUnion('role', [
    SystemMessageSchema,
    UserMessageSchema,
    AssistantMessageSchema,
]);
export type TextAgentMessage = z.infer<typeof TextAgentMessageSchema>;

export const ToolAgentMessageSchema = z
    .object({
        role: z.literal('tool'),
        toolCallId: z.string().min(1),
        status: ToolResultStatusSchema,
        output: z.string().optional(),
        error: ProtocolErrorSchema.optional(),
        redactions: z.array(RedactionMetadataSchema).optional(),
    })
    .strict()
    .superRefine((message, context) => {
        if (message.status === 'completed' && message.error !== undefined) {
            context.addIssue({
                code: 'custom',
                message: 'completed tool result messages must not include an error',
                path: ['error'],
            });
        }
        if (message.status === 'failed' && message.error === undefined) {
            context.addIssue({
                code: 'custom',
                message: 'failed tool result messages must include an error',
                path: ['error'],
            });
        }
    });
export type ToolAgentMessage = z.infer<typeof ToolAgentMessageSchema>;

export const AgentMessageSchema = z.discriminatedUnion('role', [
    SystemMessageSchema,
    UserMessageSchema,
    AssistantMessageSchema,
    ToolAgentMessageSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
