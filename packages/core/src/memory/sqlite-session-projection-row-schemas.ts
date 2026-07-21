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
    session_id: z.string(),
    status: SessionStatusSchema,
    created_at: z.string(),
    stopped_at: z.string().nullable(),
    last_event_seq: z.number().nullable(),
    parent_session_id: z.string().nullable(),
    title: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    agent_name: z.string().nullable().optional(),
    awaiting_reason: SessionAwaitingReasonSchema.nullable(),
    primary_wait_id: z.string().nullable(),
    wait_source_kind: z.enum(['approval', 'run', 'tool_call', 'job', 'child_session', 'operator']).nullable(),
    wait_source_id: z.string().nullable(),
    wait_run_id: z.string().nullable(),
    wait_tool_call_id: z.string().nullable(),
    wait_approval_id: z.string().nullable(),
    wait_job_id: z.string().nullable(),
    wait_child_session_id: z.string().nullable(),
    updated_at: z.string(),
    legacy_jsonl_path: z.string().nullable(),
    metadata_json: z.string().nullable(),
});

export const runRowSchema = z.object({
    session_id: z.string(),
    event_id: z.string(),
    sequence: z.number(),
    timestamp: z.string(),
    event_type: AgentEventTypeSchema,
    command: RunCoordinatorCommandSchema.nullable(),
    state: RunCoordinatorStateSchema.nullable(),
    run_id: z.string().nullable(),
    input_id: z.string().nullable(),
    provider_turn_id: z.string().nullable(),
    reason: z.string().nullable(),
    error_code: ProtocolErrorCodeSchema.nullable(),
});

export const approvalRowSchema = z.object({
    approval_id: z.string(),
    session_id: z.string(),
    status: ApprovalLifecycleStateSchema,
    subject_kind: ApprovalSubjectSchema.shape.kind,
    subject_id: z.string(),
    requested_at: z.string(),
    decided_at: z.string().nullable(),
    metadata_json: z.string().nullable(),
});

export const toolRowSchema = z.object({
    tool_call_id: z.string(),
    session_id: z.string(),
    name: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    result_json: z.string().nullable(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    failed_at: z.string().nullable(),
    last_message: z.string().nullable(),
    error_json: z.string().nullable(),
    applied_files_json: z.string().nullable(),
});

export const providerFailureRowSchema = z.object({
    session_id: z.string(),
    event_id: z.string(),
    request_id: z.string(),
    provider_turn_id: z.string().nullable(),
    timestamp: z.string(),
    error_json: z.string(),
});

export const diagnosticRowSchema = z.object({
    session_id: z.string(),
    file_path: z.string(),
    code: z.enum(['corrupt_line', 'invalid_header', 'invalid_sequence', 'session_mismatch', 'unknown']),
    message: z.string(),
    line_number: z.number().nullable(),
});
