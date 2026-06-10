import { z } from 'zod';
import { TRANSCRIPT_DELIVERY_MODES } from './transcript.js';

export const RUN_COORDINATOR_COMMANDS = ['wake', 'run', 'resume', 'interrupt', 'steer', 'queue'] as const;
export const RUN_COORDINATOR_STATES = ['idle', 'running', 'interrupted', 'completed'] as const;

export const RunCoordinatorCommandSchema = z.enum(RUN_COORDINATOR_COMMANDS);
export type RunCoordinatorCommand = z.infer<typeof RunCoordinatorCommandSchema>;

export const RunCoordinatorStateSchema = z.enum(RUN_COORDINATOR_STATES);
export type RunCoordinatorState = z.infer<typeof RunCoordinatorStateSchema>;

export const RunCoordinatorEventMetadataSchema = z.object({
    command: RunCoordinatorCommandSchema.optional(),
    state: RunCoordinatorStateSchema.optional(),
    runId: z.string().min(1).optional(),
    inputId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    parentMessageId: z.string().min(1).optional(),
    delivery: z.enum(TRANSCRIPT_DELIVERY_MODES).optional(),
    providerTurnId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    graphId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
});
export type RunCoordinatorEventMetadata = z.infer<typeof RunCoordinatorEventMetadataSchema>;
