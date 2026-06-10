import { z } from 'zod';

export const TRANSCRIPT_DELIVERY_MODES = ['steer', 'queue'] as const;
export const TRANSCRIPT_VISIBILITIES = ['pending', 'model_visible'] as const;

export const TranscriptDeliveryModeSchema = z.enum(TRANSCRIPT_DELIVERY_MODES);
export type TranscriptDeliveryMode = z.infer<typeof TranscriptDeliveryModeSchema>;

export const TranscriptVisibilitySchema = z.enum(TRANSCRIPT_VISIBILITIES);
export type TranscriptVisibility = z.infer<typeof TranscriptVisibilitySchema>;

export const TranscriptEventMetadataSchema = z
    .object({
        inputId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        parentMessageId: z.string().min(1).optional(),
        delivery: TranscriptDeliveryModeSchema.optional(),
        visibility: TranscriptVisibilitySchema.optional(),
        providerTurnId: z.string().min(1).optional(),
        toolCallId: z.string().min(1).optional(),
        graphId: z.string().min(1).optional(),
        nodeId: z.string().min(1).optional(),
    })
    .strict();
export type TranscriptEventMetadata = z.infer<typeof TranscriptEventMetadataSchema>;
