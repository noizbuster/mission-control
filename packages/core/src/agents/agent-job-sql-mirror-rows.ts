import type { InValue } from '@libsql/client';
import { z } from 'zod';
import type { SessionPendingWait } from '../memory/session-status-derivation';
import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentKind, AgentRef, AgentStatus } from './runtime-registry';

const runtimeAgentMetadataSchema = z
    .object({
        displayName: z.string().min(1),
        sessionFile: z.string().min(1).optional(),
        authorityFingerprint: z.string().min(1).optional(),
        taskDepth: z.number().int().nonnegative().optional(),
    })
    .strict();

const runtimeAgentRowSchema = z
    .object({
        agent_id: z.string().min(1),
        kind: z.enum(['main', 'sub', 'advisor']),
        session_id: z.string().min(1),
        parent_agent_id: z.string().nullable().optional(),
        status: z.enum(['idle', 'running', 'parked', 'completed', 'failed', 'cancelled']),
        activity: z.string().nullable().optional(),
        created_at: z.string().min(1),
        updated_at: z.string().min(1),
        metadata_json: z.string().nullable().optional(),
    })
    .strict();

const jobResultSchema = z
    .object({
        status: z.enum(['completed', 'failed']),
        output: z.string(),
    })
    .strict();

const jobMetadataSchema = z
    .object({
        blocking: z.boolean().optional(),
    })
    .strict();

const asyncJobRowSchema = z
    .object({
        job_id: z.string().min(1),
        parent_session_id: z.string().nullable().optional(),
        child_session_id: z.string().min(1),
        agent_id: z.string().nullable().optional(),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
        queued_at: z.string().min(1),
        started_at: z.string().nullable().optional(),
        completed_at: z.string().nullable().optional(),
        failed_at: z.string().nullable().optional(),
        cancelled_at: z.string().nullable().optional(),
        cancellation_reason: z.string().nullable().optional(),
        result_json: z.string().nullable().optional(),
        error_json: z.string().nullable().optional(),
        metadata_json: z.string().nullable().optional(),
    })
    .strict();

const waitMetadataSchema = z
    .object({
        mode: z.enum(['sync', 'detached']),
    })
    .strict();

const pendingWaitRowSchema = z
    .object({
        wait_id: z.string().min(1),
        reason: z.enum(['approval', 'user_input', 'subagent']),
        source_kind: z.enum(['approval', 'run', 'tool_call', 'job', 'child_session', 'operator']),
        source_id: z.string().min(1),
        job_id: z.string().nullable().optional(),
        child_session_id: z.string().nullable().optional(),
        metadata_json: z.string().nullable().optional(),
    })
    .strict();

export function parseAgentRef(row: unknown): AgentRef | undefined {
    const parsed = runtimeAgentRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    const metadata = parseJson(parsed.data.metadata_json, runtimeAgentMetadataSchema);
    if (metadata === undefined) return undefined;
    return {
        id: parsed.data.agent_id,
        displayName: metadata.displayName,
        kind: parsed.data.kind satisfies AgentKind,
        ...(parsed.data.parent_agent_id !== null && parsed.data.parent_agent_id !== undefined
            ? { parentId: parsed.data.parent_agent_id }
            : {}),
        status: runtimeStatusFromDb(parsed.data.status),
        sessionId: parsed.data.session_id,
        ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
        ...(metadata.authorityFingerprint !== undefined ? { authorityFingerprint: metadata.authorityFingerprint } : {}),
        ...(metadata.taskDepth !== undefined ? { taskDepth: metadata.taskDepth } : {}),
        createdAt: parsed.data.created_at,
        lastActivity: parsed.data.updated_at,
        ...(parsed.data.activity !== null && parsed.data.activity !== undefined
            ? { activity: parsed.data.activity }
            : {}),
    };
}

export function parseJob(row: unknown): BackgroundJobHandle | undefined {
    const parsed = asyncJobRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    const result = parseJson(parsed.data.result_json, jobResultSchema);
    const metadata = parseJson(parsed.data.metadata_json, jobMetadataSchema) ?? {};
    const error = parseErrorMessage(parsed.data.error_json);
    const completedAt = parsed.data.completed_at ?? parsed.data.failed_at ?? parsed.data.cancelled_at ?? undefined;
    return {
        jobId: parsed.data.job_id,
        sessionId: parsed.data.child_session_id,
        ...(parsed.data.parent_session_id !== null && parsed.data.parent_session_id !== undefined
            ? { parentSessionId: parsed.data.parent_session_id }
            : {}),
        ...(parsed.data.agent_id !== null && parsed.data.agent_id !== undefined
            ? { agentId: parsed.data.agent_id }
            : {}),
        ...(metadata.blocking !== undefined ? { blocking: metadata.blocking } : {}),
        status: parsed.data.status,
        startedAt: parsed.data.queued_at,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(parsed.data.cancellation_reason !== null && parsed.data.cancellation_reason !== undefined
            ? { cancellationReason: parsed.data.cancellation_reason }
            : {}),
    };
}

export function parsePendingWait(row: unknown): SessionPendingWait | undefined {
    const parsed = pendingWaitRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    if (parsed.data.reason !== 'subagent') return undefined;
    const metadata = parseJson(parsed.data.metadata_json, waitMetadataSchema) ?? { mode: 'sync' };
    const childSessionId = parsed.data.child_session_id ?? parsed.data.source_id;
    return {
        waitId: parsed.data.wait_id,
        reason: 'subagent',
        source: {
            kind: 'subagent',
            jobId: parsed.data.job_id ?? parsed.data.wait_id,
            childSessionId,
            mode: metadata.mode,
        },
    };
}

export function runtimeStatusToDb(status: AgentStatus): InValue {
    switch (status) {
        case 'idle':
        case 'running':
        case 'parked':
            return status;
        case 'aborted':
            return 'failed';
        default:
            return assertNever(status);
    }
}

function parseJson<T>(raw: string | null | undefined, schema: z.ZodType<T>): T | undefined {
    if (raw === null || raw === undefined) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
}

function parseErrorMessage(raw: string | null | undefined): string | undefined {
    const parsed = parseJson(
        raw,
        z
            .object({
                message: z.string(),
            })
            .strict(),
    );
    return parsed?.message;
}

function runtimeStatusFromDb(
    status: 'idle' | 'running' | 'parked' | 'completed' | 'failed' | 'cancelled',
): AgentStatus {
    switch (status) {
        case 'idle':
        case 'running':
        case 'parked':
            return status;
        case 'completed':
            return 'idle';
        case 'failed':
        case 'cancelled':
            return 'aborted';
        default:
            return assertNever(status);
    }
}

function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
