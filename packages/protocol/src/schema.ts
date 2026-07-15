import { z } from 'zod';
import { AbgEventMetadataSchema } from './abg';
import { APPROVAL_POLICY_DECISIONS, ApprovalPolicyDecisionSchema, ApprovalRecordSchema } from './approval';
import { CommandRunEventMetadataSchema } from './command-events';
import { DiffFileSchema } from './diff-events';
import { EventIdSchema, EventSequenceSchema } from './event-primitives';
import { PermissionDecisionSchema, PermissionReplySchema, PermissionRequestSchema } from './permission-profile';
import { ModelProviderSelectionSchema } from './provider-auth';
import { ProviderStreamChunkSchema, ToolResultSchema } from './provider-events';
import { OperatorAbortedRunEventMetadataSchema, RunCoordinatorEventMetadataSchema } from './run-coordinator';
import {
    refineSessionAwaitingContract,
    SessionAwaitingDetailsSchema,
    SessionStatusSchema,
} from './session-lifecycle';
import { SessionAbortCompletedMetadataSchema } from './session-stop';
import { SESSION_TREE_EVENT_TYPES, SessionTreeEventMetadataSchema } from './session-tree';
import { NativeSidecarStatusSchema } from './sidecar';
import { PromptCancelledEventMetadataSchema, TranscriptEventMetadataSchema } from './transcript';

export * from './schema-exports';

export const AGENT_EVENT_TYPES = [
    'session.started',
    'session.stopped',
    'session.abort.completed',
    ...SESSION_TREE_EVENT_TYPES,
    'task.started',
    'task.progress',
    'task.completed',
    'task.failed',
    'permission.requested',
    'permission.replied',
    'permission.reply_not_found',
    'approval.requested',
    'approval.updated',
    'approval.blocked',
    'approval.resumed',
    'prompt.admitted',
    'prompt.promoted',
    'prompt.cancelled',
    'run.command.received',
    'run.started',
    'run.completed',
    'run.interrupted',
    'run.idle',
    'run.failed',
    'run.blocked',
    'native.status',
    'native.warning',
    'log',
    'graph.started',
    'graph.completed',
    'graph.failed',
    'graph.cancelled',
    'attempt.started',
    'attempt.completed',
    'attempt.failed',
    'node.waiting',
    'node.started',
    'node.progress',
    'node.completed',
    'node.failed',
    'node.cancelled',
    'node.escalated',
    'node.fallback',
    'decision.selected',
    'policy.blocked',
    'model.call.started',
    'model.call.completed',
    'model.call.failed',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'command.started',
    'command.completed',
    'command.failed',
    'command.timed_out',
    'file.diff.proposed',
    'file.diff.applied',
    'workflow.transitioned',
    // v2: cost ledger surface — emitted by CostLedger.accumulate() and projected
    // from emit signals into first-class durable events so the overlay Cost&Policy
    // pane can read running $ totals from `event.abg.emit.payload.cents`.
    'policy.budget.accumulated',
    'policy.budget.warning',
    'policy.budget.exceeded',
    // v2: blackboard surface — emitted by the Blackboard class on key mutations so
    // the overlay Blackboard tab can observe the agent's evolving working memory
    // (goals, hypotheses, decisions, observations) without polling the snapshot.
    'blackboard.set',
    'blackboard.delete',
] as const;

export const PERMISSION_STATUSES = APPROVAL_POLICY_DECISIONS;

export const EVENT_DURABILITIES = ['durable', 'ephemeral'] as const;

export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const PermissionStatusSchema = ApprovalPolicyDecisionSchema;
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const EventDurabilitySchema = z.enum(EVENT_DURABILITIES);
export type EventDurability = z.infer<typeof EventDurabilitySchema>;

export const AgentEventSchema = z
    .object({
        type: AgentEventTypeSchema,
        timestamp: z.string().datetime(),
        durability: EventDurabilitySchema.optional(),
        sessionId: z.string().optional(),
        taskId: z.string().optional(),
        message: z.string().optional(),
        progress: z.number().min(0).max(1).optional(),
        nativeSidecarStatus: NativeSidecarStatusSchema.optional(),
        permissionRequest: PermissionRequestSchema.optional(),
        permissionDecision: PermissionDecisionSchema.optional(),
        permissionReply: PermissionReplySchema.optional(),
        approvalRecord: ApprovalRecordSchema.optional(),
        modelProviderSelection: ModelProviderSelectionSchema.optional(),
        providerStreamChunk: z.lazy(() => ProviderStreamChunkSchema).optional(),
        toolResult: ToolResultSchema.optional(),
        diffFiles: z.array(DiffFileSchema).optional(),
        command: CommandRunEventMetadataSchema.optional(),
        run: RunCoordinatorEventMetadataSchema.optional(),
        sessionStop: SessionAbortCompletedMetadataSchema.optional(),
        sessionTree: SessionTreeEventMetadataSchema.optional(),
        transcript: TranscriptEventMetadataSchema.optional(),
        abg: AbgEventMetadataSchema.optional(),
    })
    .superRefine((event, context) => {
        if (
            event.type === 'prompt.cancelled' &&
            !PromptCancelledEventMetadataSchema.safeParse(event.transcript).success
        ) {
            context.addIssue({
                code: 'custom',
                message: 'prompt.cancelled requires inputId, delivery, requestId, and operator_aborted reason',
                path: ['transcript'],
            });
        }

        if (
            event.type === 'session.abort.completed' &&
            !SessionAbortCompletedMetadataSchema.safeParse(event.sessionStop).success
        ) {
            context.addIssue({
                code: 'custom',
                message: 'session.abort.completed requires operation, request, reason, and affected counts',
                path: ['sessionStop'],
            });
        }

        const hasStructuredStopMetadata = event.run?.reason === 'operator_aborted';
        if (
            event.type === 'run.interrupted' &&
            hasStructuredStopMetadata &&
            !OperatorAbortedRunEventMetadataSchema.safeParse(event.run).success
        ) {
            context.addIssue({
                code: 'custom',
                message: 'operator-aborted run interruption requires state, reason, requestId, and operationId',
                path: ['run'],
            });
        }
    });
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentEventEnvelopeSchema = z.object({
    eventId: EventIdSchema,
    sequence: EventSequenceSchema,
    createdAt: z.string().datetime(),
    sessionId: z.string().min(1),
    durability: EventDurabilitySchema,
    causationId: EventIdSchema.optional(),
    correlationId: z.string().min(1).optional(),
    event: AgentEventSchema,
});
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export const AgentEventLogSchema = z.array(AgentEventEnvelopeSchema).superRefine((events, context) => {
    let previousSequence = -1;
    const seenEventIds = new Set<string>();

    events.forEach((event, index) => {
        if (event.sequence <= previousSequence) {
            context.addIssue({
                code: 'custom',
                message: 'event sequences must be strictly increasing',
                path: [index, 'sequence'],
            });
        }

        if (seenEventIds.has(event.eventId)) {
            context.addIssue({
                code: 'custom',
                message: 'event ids must be unique within a log',
                path: [index, 'eventId'],
            });
        }

        previousSequence = event.sequence;
        seenEventIds.add(event.eventId);
    });
});
export type AgentEventLog = z.infer<typeof AgentEventLogSchema>;

export const ReplayCursorSchema = z.object({
    sessionId: z.string().min(1),
    sequence: EventSequenceSchema,
    eventId: EventIdSchema,
});
export type ReplayCursor = z.infer<typeof ReplayCursorSchema>;

export const AgentSessionSchema = z
    .object({
        id: z.string().min(1),
        status: SessionStatusSchema,
        awaiting: SessionAwaitingDetailsSchema.optional(),
        startedAt: z.string().datetime(),
        stoppedAt: z.string().datetime().optional(),
    })
    .superRefine(refineSessionAwaitingContract);
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentSnapshotSchema = z
    .object({
        sessionId: z.string().min(1),
        status: SessionStatusSchema,
        awaiting: SessionAwaitingDetailsSchema.optional(),
        startedAt: z.string().datetime(),
        stoppedAt: z.string().datetime().optional(),
        runningTaskCount: z.number().int().nonnegative(),
        completedTaskCount: z.number().int().nonnegative(),
        failedTaskCount: z.number().int().nonnegative(),
        lastEvent: AgentEventSchema.optional(),
        lastMessage: z.string().optional(),
        nativeSidecarStatus: NativeSidecarStatusSchema,
        modelProviderSelection: ModelProviderSelectionSchema.optional(),
    })
    .superRefine(refineSessionAwaitingContract);
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
