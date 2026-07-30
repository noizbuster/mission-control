import {
    AgentEventTypeSchema,
    ApprovalLifecycleStateSchema,
    ApprovalSubjectSchema,
    ProtocolErrorCodeSchema,
    RunCoordinatorCommandSchema,
    RunCoordinatorStateSchema,
    SessionAwaitingReasonSchema,
    SessionStatusSchema,
} from '@mission-control/protocol';
import { z } from 'zod';

export const sessionRowSchema = z.object({
    sessionId: z.string(),
    status: SessionStatusSchema,
    createdAt: z.string(),
    stoppedAt: z.string().nullable(),
    lastEventSeq: z.number().nullable(),
    parentSessionId: z.string().nullable(),
    title: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    agentName: z.string().nullable().optional(),
    workspacePath: z.string().nullable().optional(),
    awaitingReason: SessionAwaitingReasonSchema.nullable(),
    primaryWaitId: z.string().nullable(),
    waitSourceKind: z.enum(['approval', 'run', 'tool_call', 'job', 'child_session', 'operator']).nullable(),
    waitSourceId: z.string().nullable(),
    waitRunId: z.string().nullable(),
    waitToolCallId: z.string().nullable(),
    waitApprovalId: z.string().nullable(),
    waitJobId: z.string().nullable(),
    waitChildSessionId: z.string().nullable(),
    updatedAt: z.string(),
    legacyJsonlPath: z.string().nullable(),
    metadataJson: z.string().nullable(),
});

export const runRowSchema = z.object({
    sessionId: z.string(),
    eventId: z.string(),
    sequence: z.number(),
    timestamp: z.string(),
    eventType: AgentEventTypeSchema,
    command: RunCoordinatorCommandSchema.nullable(),
    state: RunCoordinatorStateSchema.nullable(),
    runId: z.string().nullable(),
    inputId: z.string().nullable(),
    providerTurnId: z.string().nullable(),
    reason: z.string().nullable(),
    errorCode: ProtocolErrorCodeSchema.nullable(),
});

export const approvalRowSchema = z.object({
    approvalId: z.string(),
    sessionId: z.string(),
    status: ApprovalLifecycleStateSchema,
    subjectKind: ApprovalSubjectSchema.shape.kind,
    subjectId: z.string(),
    requestedAt: z.string(),
    decidedAt: z.string().nullable(),
    metadataJson: z.string().nullable(),
});

export const toolRowSchema = z.object({
    toolCallId: z.string(),
    sessionId: z.string(),
    name: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    resultJson: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    lastMessage: z.string().nullable(),
    errorJson: z.string().nullable(),
    appliedFilesJson: z.string().nullable(),
});

export const providerFailureRowSchema = z.object({
    sessionId: z.string(),
    eventId: z.string(),
    requestId: z.string(),
    providerTurnId: z.string().nullable(),
    timestamp: z.string(),
    errorJson: z.string(),
});

export const diagnosticRowSchema = z.object({
    sessionId: z.string(),
    filePath: z.string(),
    code: z.enum(['corrupt_line', 'invalid_header', 'invalid_sequence', 'session_mismatch', 'unknown']),
    message: z.string(),
    lineNumber: z.number().nullable(),
});
