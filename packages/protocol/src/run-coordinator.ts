import { z } from 'zod';
import { SessionStopReasonSchema } from './session-stop';
import { ProtocolErrorCodeSchema } from './tool-result-primitives';
import { TRANSCRIPT_DELIVERY_MODES } from './transcript';

export const RUN_COORDINATOR_COMMANDS = ['wake', 'run', 'resume', 'interrupt', 'steer', 'queue'] as const;
export const RUN_COORDINATOR_STATES = [
    'idle',
    'running',
    'interrupted',
    'completed',
    'failed',
    'blocked_on_approval',
] as const;

export const RunCoordinatorCommandSchema = z.enum(RUN_COORDINATOR_COMMANDS);
export type RunCoordinatorCommand = z.infer<typeof RunCoordinatorCommandSchema>;

export const RunCoordinatorStateSchema = z.enum(RUN_COORDINATOR_STATES);
export type RunCoordinatorState = z.infer<typeof RunCoordinatorStateSchema>;

export const RunCoordinatorEventMetadataSchema = z
    .object({
        command: RunCoordinatorCommandSchema.optional(),
        state: RunCoordinatorStateSchema.optional(),
        runId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        operationId: z.string().min(1).optional(),
        inputId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        parentMessageId: z.string().min(1).optional(),
        delivery: z.enum(TRANSCRIPT_DELIVERY_MODES).optional(),
        providerTurnId: z.string().min(1).optional(),
        toolCallId: z.string().min(1).optional(),
        graphId: z.string().min(1).optional(),
        nodeId: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        errorCode: ProtocolErrorCodeSchema.optional(),
    })
    .strict();
export type RunCoordinatorEventMetadata = z.infer<typeof RunCoordinatorEventMetadataSchema>;

export const OperatorAbortedRunEventMetadataSchema = RunCoordinatorEventMetadataSchema.extend({
    state: z.literal('interrupted'),
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    reason: SessionStopReasonSchema,
}).strict();
export type OperatorAbortedRunEventMetadata = z.infer<typeof OperatorAbortedRunEventMetadataSchema>;
