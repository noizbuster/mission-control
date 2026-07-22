import { z } from 'zod';

export const SESSION_FINALIZE_STATUSES = ['complete', 'aborted', 'failed'] as const;
export type SessionFinalizeStatus = (typeof SESSION_FINALIZE_STATUSES)[number];

export const SessionFinalizeStatusSchema = z.enum(SESSION_FINALIZE_STATUSES);

export const SessionFinalizeEventMetadataSchema = z.object({
    status: SessionFinalizeStatusSchema,
    reason: z.string().optional(),
});
export type SessionFinalizeEventMetadata = z.infer<typeof SessionFinalizeEventMetadataSchema>;
