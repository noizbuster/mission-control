import { z } from 'zod';
import { AbgEventMetadataSchema } from './abg.js';
import { APPROVAL_POLICY_DECISIONS, ApprovalPolicyDecisionSchema, ApprovalRecordSchema } from './approval.js';
import { CommandRunEventMetadataSchema } from './command-events.js';
import { DiffFileSchema } from './diff-events.js';
import { EventIdSchema, EventSequenceSchema } from './event-primitives.js';
import { PermissionDecisionSchema, PermissionReplySchema, PermissionRequestSchema } from './permission-profile.js';
import { ModelProviderSelectionSchema } from './provider-auth.js';
import { ProviderStreamChunkSchema, ToolResultSchema } from './provider-events.js';
import { RunCoordinatorEventMetadataSchema } from './run-coordinator.js';
import { SESSION_TREE_EVENT_TYPES, SessionTreeEventMetadataSchema } from './session-tree.js';
import { NativeSidecarStatusSchema } from './sidecar.js';
import { TranscriptEventMetadataSchema } from './transcript.js';

export {
    APPROVAL_LIFECYCLE_STATES,
    APPROVAL_POLICY_DECISIONS,
    type ApprovalLifecycleState,
    ApprovalLifecycleStateSchema,
    type ApprovalPolicyDecision,
    ApprovalPolicyDecisionSchema,
    type ApprovalRecord,
    ApprovalRecordSchema,
    type ApprovalSubject,
    ApprovalSubjectSchema,
} from './approval.js';
export {
    PERMISSION_KINDS,
    PERMISSION_REPLY_VALUES,
    PERMISSION_RULE_DECISIONS,
    type PermissionDecision,
    PermissionDecisionSchema,
    type PermissionKind,
    PermissionKindSchema,
    type PermissionReply,
    PermissionReplySchema,
    type PermissionReplyValue,
    PermissionReplyValueSchema,
    type PermissionRequest,
    PermissionRequestSchema,
    type PermissionRule,
    type PermissionRuleDecision,
    PermissionRuleDecisionSchema,
    PermissionRuleSchema,
    type PermissionScope,
    PermissionScopeSchema,
} from './permission-profile.js';
export {
    MODEL_CATALOG_STATUSES,
    type ModelCatalogEntry,
    ModelCatalogEntrySchema,
    type ModelCatalogStatus,
    ModelCatalogStatusSchema,
    type ModelProviderSelection,
    ModelProviderSelectionSchema,
    type ModelVariantEntry,
    ModelVariantEntrySchema,
    type ProviderApiKeyCredential,
    ProviderApiKeyCredentialSchema,
    type ProviderAuthFile,
    ProviderAuthFileSchema,
    type ProviderCatalogEntry,
    ProviderCatalogEntrySchema,
    type ProviderCredential,
    type ProviderCredentialField,
    ProviderCredentialFieldSchema,
    ProviderCredentialSchema,
    type ProviderCredentialSummary,
    ProviderCredentialSummarySchema,
    type ProviderFieldsCredential,
    ProviderFieldsCredentialSchema,
    type ProviderOAuthCredential,
    ProviderOAuthCredentialSchema,
} from './provider-auth.js';
export {
    RUN_COORDINATOR_COMMANDS,
    RUN_COORDINATOR_STATES,
    type RunCoordinatorCommand,
    RunCoordinatorCommandSchema,
    type RunCoordinatorEventMetadata,
    RunCoordinatorEventMetadataSchema,
    type RunCoordinatorState,
    RunCoordinatorStateSchema,
} from './run-coordinator.js';
export {
    NATIVE_SIDECAR_STATUSES,
    type NativeSidecarStatus,
    NativeSidecarStatusSchema,
    SIDECAR_CAPABILITIES,
    SIDECAR_PROTOCOL_V2_VERSION,
    SIDECAR_PROTOCOL_VERSION,
    SIDECAR_PROTOCOL_VERSIONS,
    SIDECAR_V1_CAPABILITIES,
    type SidecarCancelTaskCommand,
    SidecarCancelTaskCommandSchema,
    type SidecarCapability,
    SidecarCapabilitySchema,
    type SidecarHandshakeCommand,
    SidecarHandshakeCommandSchema,
    type SidecarHandshakeResponse,
    SidecarHandshakeResponseSchema,
    type SidecarProtocolVersion,
    SidecarProtocolVersionSchema,
    type SidecarTaskCancelledResponse,
    SidecarTaskCancelledResponseSchema,
    type SidecarTaskFailedResponse,
    SidecarTaskFailedResponseSchema,
    type SidecarTaskInput,
    SidecarTaskInputSchema,
    type SidecarTaskOutput,
    SidecarTaskOutputSchema,
    type SidecarWireResponse,
    SidecarWireResponseSchema,
} from './sidecar.js';

export const AGENT_EVENT_TYPES = [
    'session.started',
    'session.stopped',
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
] as const;

export const SESSION_STATUSES = ['idle', 'running', 'stopped', 'failed'] as const;

export const PERMISSION_STATUSES = APPROVAL_POLICY_DECISIONS;

export const EVENT_DURABILITIES = ['durable', 'ephemeral'] as const;

export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const PermissionStatusSchema = ApprovalPolicyDecisionSchema;
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const EventDurabilitySchema = z.enum(EVENT_DURABILITIES);
export type EventDurability = z.infer<typeof EventDurabilitySchema>;

export const AgentEventSchema = z.object({
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
    sessionTree: SessionTreeEventMetadataSchema.optional(),
    transcript: TranscriptEventMetadataSchema.optional(),
    abg: AbgEventMetadataSchema.optional(),
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

export const AgentSessionSchema = z.object({
    id: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentSnapshotSchema = z.object({
    sessionId: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
    runningTaskCount: z.number().int().nonnegative(),
    completedTaskCount: z.number().int().nonnegative(),
    failedTaskCount: z.number().int().nonnegative(),
    lastEvent: AgentEventSchema.optional(),
    lastMessage: z.string().optional(),
    nativeSidecarStatus: NativeSidecarStatusSchema,
    modelProviderSelection: ModelProviderSelectionSchema.optional(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;

export {
    type AgentMessage,
    AgentMessageSchema,
    type EventId,
    EventIdSchema,
    type EventSequence,
    EventSequenceSchema,
    type ProviderToolCallTranscript,
    ProviderToolCallTranscriptSchema,
    type TextAgentMessage,
    TextAgentMessageSchema,
    type ToolAgentMessage,
    ToolAgentMessageSchema,
} from './event-primitives.js';
