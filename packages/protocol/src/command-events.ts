import { z } from 'zod';

export const COMMAND_EVENT_STATUSES = ['started', 'completed', 'failed', 'timed_out'] as const;

export const CommandEventStatusSchema = z.enum(COMMAND_EVENT_STATUSES);
export type CommandEventStatus = z.infer<typeof CommandEventStatusSchema>;

export const CommandRunEventMetadataSchema = z
    .object({
        command: z.array(z.string().min(1)).min(1),
        cwd: z.string().min(1),
        status: CommandEventStatusSchema,
        exitCode: z.number().int().nullable().optional(),
        signal: z.string().nullable().optional(),
        timedOut: z.boolean().optional(),
        stdoutTruncated: z.boolean().optional(),
        stderrTruncated: z.boolean().optional(),
        durationMs: z.number().nonnegative().optional(),
    })
    .strict();
export type CommandRunEventMetadata = z.infer<typeof CommandRunEventMetadataSchema>;
