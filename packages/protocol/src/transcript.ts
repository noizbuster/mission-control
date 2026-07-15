import { z } from 'zod';
import { SessionStopReasonSchema } from './session-stop';

export const TRANSCRIPT_DELIVERY_MODES = ['steer', 'queue'] as const;
export const TRANSCRIPT_VISIBILITIES = ['pending', 'model_visible'] as const;

export const TranscriptDeliveryModeSchema = z.enum(TRANSCRIPT_DELIVERY_MODES);
export type TranscriptDeliveryMode = z.infer<typeof TranscriptDeliveryModeSchema>;

export const TranscriptVisibilitySchema = z.enum(TRANSCRIPT_VISIBILITIES);
export type TranscriptVisibility = z.infer<typeof TranscriptVisibilitySchema>;

export const TranscriptEventMetadataSchema = z
    .object({
        inputId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        parentMessageId: z.string().min(1).optional(),
        delivery: TranscriptDeliveryModeSchema.optional(),
        reason: z.string().min(1).optional(),
        visibility: TranscriptVisibilitySchema.optional(),
        providerTurnId: z.string().min(1).optional(),
        toolCallId: z.string().min(1).optional(),
        graphId: z.string().min(1).optional(),
        nodeId: z.string().min(1).optional(),
    })
    .strict();
export type TranscriptEventMetadata = z.infer<typeof TranscriptEventMetadataSchema>;

export const PromptCancelledEventMetadataSchema = TranscriptEventMetadataSchema.extend({
    inputId: z.string().min(1),
    requestId: z.string().min(1),
    delivery: TranscriptDeliveryModeSchema,
    reason: SessionStopReasonSchema,
});
export type PromptCancelledEventMetadata = z.infer<typeof PromptCancelledEventMetadataSchema>;
