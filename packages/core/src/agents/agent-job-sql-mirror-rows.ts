import { ProtocolErrorSchema } from '@mission-control/protocol';
import { z } from 'zod';
import type { RuntimeAgentStatus } from '../db/session-schema-literals';
import type { SessionPendingWait } from '../memory/session-status-derivation';
import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentKind, AgentRef, AgentStatus } from './runtime-registry';

const runtimeAgentMetadataSchema = z
    .object({
        displayName: z.string().min(1),
        sessionFile: z.string().min(1).optional(),
        authorityFingerprint: z.string().min(1).optional(),
        taskDepth: z.number().int().nonnegative().optional(),
        category: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
    })
    .strict();

const runtimeAgentRowSchema = z
    .object({
        agentId: z.string().min(1),
        kind: z.enum(['main', 'sub', 'advisor']),
        sessionId: z.string().min(1),
        parentAgentId: z.string().nullable().optional(),
        status: z.enum(['idle', 'running', 'parked', 'completed', 'failed', 'cancelled']),
        activity: z.string().nullable().optional(),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
        metadataJson: z.string().nullable().optional(),
    })
    .strict();

const jobResultSchema = z
    .object({
        status: z.enum(['completed', 'failed']),
        output: z.string(),
        failure: ProtocolErrorSchema.optional(),
    })
    .strict();

const jobMetadataSchema = z
    .object({
        blocking: z.boolean().optional(),
    })
    .strict();

const asyncJobRowSchema = z
    .object({
        jobId: z.string().min(1),
        parentSessionId: z.string().nullable().optional(),
        childSessionId: z.string().min(1),
        agentId: z.string().nullable().optional(),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
        queuedAt: z.string().min(1),
        startedAt: z.string().nullable().optional(),
        completedAt: z.string().nullable().optional(),
        failedAt: z.string().nullable().optional(),
        cancelledAt: z.string().nullable().optional(),
        cancellationReason: z.string().nullable().optional(),
        resultJson: z.string().nullable().optional(),
        errorJson: z.string().nullable().optional(),
        metadataJson: z.string().nullable().optional(),
    })
    .strict();

const waitMetadataSchema = z
    .object({
        mode: z.enum(['sync', 'detached']),
    })
    .strict();

const pendingWaitRowSchema = z
    .object({
        waitId: z.string().min(1),
        reason: z.enum(['approval', 'user_input', 'subagent']),
        sourceKind: z.enum(['approval', 'run', 'tool_call', 'job', 'child_session', 'operator']),
        sourceId: z.string().min(1),
        jobId: z.string().nullable().optional(),
        childSessionId: z.string().nullable().optional(),
        metadataJson: z.string().nullable().optional(),
    })
    .strict();

export function parseAgentRef(row: unknown): AgentRef | undefined {
    const parsed = runtimeAgentRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    const metadata = parseJson(parsed.data.metadataJson, runtimeAgentMetadataSchema);
    if (metadata === undefined) return undefined;
    return {
        id: parsed.data.agentId,
        displayName: metadata.displayName,
        kind: parsed.data.kind satisfies AgentKind,
        ...(parsed.data.parentAgentId !== null && parsed.data.parentAgentId !== undefined
            ? { parentId: parsed.data.parentAgentId }
            : {}),
        status: runtimeStatusFromDb(parsed.data.status),
        sessionId: parsed.data.sessionId,
        ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
        ...(metadata.authorityFingerprint !== undefined ? { authorityFingerprint: metadata.authorityFingerprint } : {}),
        ...(metadata.taskDepth !== undefined ? { taskDepth: metadata.taskDepth } : {}),
        ...(metadata.category !== undefined ? { category: metadata.category } : {}),
        ...(metadata.title !== undefined ? { title: metadata.title } : {}),
        createdAt: parsed.data.createdAt,
        lastActivity: parsed.data.updatedAt,
        ...(parsed.data.activity !== null && parsed.data.activity !== undefined
            ? { activity: parsed.data.activity }
            : {}),
    };
}

export function parseJob(row: unknown): BackgroundJobHandle | undefined {
    const parsed = asyncJobRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    const parsedResult = parseJson(parsed.data.resultJson, jobResultSchema);
    const result =
        parsedResult === undefined
            ? undefined
            : {
                  status: parsedResult.status,
                  output: parsedResult.output,
                  ...(parsedResult.failure !== undefined ? { failure: parsedResult.failure } : {}),
              };
    const metadata = parseJson(parsed.data.metadataJson, jobMetadataSchema) ?? {};
    const completedAt = parsed.data.completedAt ?? parsed.data.failedAt ?? parsed.data.cancelledAt ?? undefined;
    return {
        jobId: parsed.data.jobId,
        sessionId: parsed.data.childSessionId,
        ...(parsed.data.parentSessionId !== null && parsed.data.parentSessionId !== undefined
            ? { parentSessionId: parsed.data.parentSessionId }
            : {}),
        ...(parsed.data.agentId !== null && parsed.data.agentId !== undefined
            ? { agentId: parsed.data.agentId }
            : {}),
        ...(metadata.blocking !== undefined ? { blocking: metadata.blocking } : {}),
        status: parsed.data.status,
        startedAt: parsed.data.queuedAt,
        ...(result !== undefined ? { result } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(parsed.data.cancellationReason !== null && parsed.data.cancellationReason !== undefined
            ? { cancellationReason: parsed.data.cancellationReason }
            : {}),
    };
}

export function parsePendingWait(row: unknown): SessionPendingWait | undefined {
    const parsed = pendingWaitRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    if (parsed.data.reason !== 'subagent') return undefined;
    const metadata = parseJson(parsed.data.metadataJson, waitMetadataSchema) ?? { mode: 'sync' };
    const childSessionId = parsed.data.childSessionId ?? parsed.data.sourceId;
    return {
        waitId: parsed.data.waitId,
        reason: 'subagent',
        source: {
            kind: 'subagent',
            jobId: parsed.data.jobId ?? parsed.data.waitId,
            childSessionId,
            mode: metadata.mode,
        },
    };
}

export function runtimeStatusToDb(status: AgentStatus): RuntimeAgentStatus {
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
