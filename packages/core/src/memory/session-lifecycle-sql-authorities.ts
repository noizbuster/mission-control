import type { Client } from '@libsql/client';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import {
    asyncJobs,
    missionRuns,
    sessionAwaits,
    sessionEvents,
    sessionInputs,
    sessionProjectionRuns,
    sessions,
} from '../db/schema';
import {
    deriveSessionLifecycle,
    type SessionAbortMarker,
    type SessionActiveRun,
    type SessionBackgroundJob,
    type SessionLifecycleDerivation,
    type SessionMissionRun,
    type SessionPendingInput,
    type SessionPendingWait,
    type SessionTerminalEvent,
} from './session-status-derivation';

const sessionRowSchema = z.object({
    status: z.enum(['idle', 'running', 'awaiting', 'stopped', 'failed']),
    stoppedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
});
const idRowSchema = z.object({ runId: z.string() });
const missionRunRowSchema = z.object({ runId: z.string(), status: z.enum(['pending', 'running', 'blocked']) });
const inputRowSchema = z.object({ inputId: z.string() });
const waitRowSchema = z.object({
    waitId: z.string(),
    reason: z.enum(['approval', 'user_input', 'subagent']),
    sourceId: z.string(),
    approvalId: z.string().nullable(),
    jobId: z.string().nullable(),
    childSessionId: z.string().nullable(),
    metadataJson: z.string().nullable(),
});
const jobRowSchema = z.object({
    jobId: z.string(),
    childSessionId: z.string().nullable(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    metadataJson: z.string().nullable(),
});
const markerRowSchema = z.object({ type: z.enum(['session.abort.completed', 'run.started']) });
const sessionMetadataRowSchema = z.object({ metadataJson: z.string().nullable() });
const abortMetadataSchema = z.object({ abortMarkerAt: z.string().min(1).optional() }).passthrough();
const waitMetadataSchema = z.object({ mode: z.enum(['sync', 'detached']).optional() }).passthrough();
const jobMetadataSchema = z.object({ blocking: z.boolean().optional() }).passthrough();

export async function deriveSessionLifecycleFromSql(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<SessionLifecycleDerivation> {
    const [terminalEvent, activeRuns, pendingWaits, missionRuns, pendingInputs, backgroundJobs, abortMarker] =
        await Promise.all([
            loadSessionTerminalEvent(input),
            loadEventActiveRuns(input),
            loadPendingWaits(input),
            loadSessionMissionRuns(input),
            loadPendingInputs(input),
            loadBackgroundJobs(input),
            loadAbortMarker(input),
        ]);
    return deriveSessionLifecycle({
        terminalEvent,
        activeRuns,
        pendingWaits,
        backgroundJobs,
        missionRuns,
        pendingInputs,
        abortMarker,
    });
}

export async function loadSessionTerminalEvent(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<SessionTerminalEvent> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({
            status: sessions.status,
            stoppedAt: sessions.stoppedAt,
            failedAt: sessions.failedAt,
        })
        .from(sessions)
        .where(eq(sessions.sessionId, input.sessionId));
    const row = rows[0];
    if (row === undefined) return { kind: 'none' };
    const session = sessionRowSchema.parse(row);
    if (session.status === 'failed' || session.failedAt !== null) return { kind: 'failed' };
    if (session.status === 'stopped' || session.stoppedAt !== null) return { kind: 'stopped' };
    return { kind: 'none' };
}

export async function loadSessionActiveRuns(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionActiveRun[]> {
    return loadEventActiveRuns(input);
}

async function loadEventActiveRuns(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionActiveRun[]> {
    if (!(await tableExists(input.client, 'session_projection_runs'))) return [];
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ runId: sessionProjectionRuns.runId })
        .from(sessionProjectionRuns)
        .where(
            and(
                eq(sessionProjectionRuns.sessionId, input.sessionId),
                isNotNull(sessionProjectionRuns.runId),
                inArray(sessionProjectionRuns.state, ['running', 'blocked_on_approval']),
                eq(
                    sessionProjectionRuns.sequence,
                    sql`(
                        SELECT MAX(latest.sequence)
                        FROM session_projection_runs latest
                        WHERE latest.session_id = ${sessionProjectionRuns.sessionId}
                          AND latest.run_id = ${sessionProjectionRuns.runId}
                    )`,
                ),
            ),
        )
        .orderBy(asc(sessionProjectionRuns.runId));
    return rows.flatMap((row) => {
        if (row.runId === null) return [];
        return [{ runId: idRowSchema.parse({ runId: row.runId }).runId }];
    });
}

async function loadSessionMissionRuns(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionMissionRun[]> {
    if (!(await tableExists(input.client, 'mission_runs'))) return [];
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ runId: missionRuns.runId, status: missionRuns.status })
        .from(missionRuns)
        .where(
            and(
                eq(missionRuns.sessionId, input.sessionId),
                inArray(missionRuns.status, ['pending', 'running', 'blocked']),
            ),
        )
        .orderBy(asc(missionRuns.runId));
    return rows.map((row) => {
        const parsed = missionRunRowSchema.parse(row);
        return { runId: parsed.runId, status: parsed.status };
    });
}

async function loadPendingInputs(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionPendingInput[]> {
    if (!(await tableExists(input.client, 'session_inputs'))) return [];
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ inputId: sessionInputs.inputId })
        .from(sessionInputs)
        .where(
            and(eq(sessionInputs.sessionId, input.sessionId), inArray(sessionInputs.status, ['pending', 'admitted'])),
        )
        .orderBy(asc(sessionInputs.inputId));
    return rows.map((row) => ({ inputId: inputRowSchema.parse(row).inputId }));
}

async function loadPendingWaits(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionPendingWait[]> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({
            waitId: sessionAwaits.waitId,
            reason: sessionAwaits.reason,
            sourceId: sessionAwaits.sourceId,
            approvalId: sessionAwaits.approvalId,
            jobId: sessionAwaits.jobId,
            childSessionId: sessionAwaits.childSessionId,
            metadataJson: sessionAwaits.metadataJson,
        })
        .from(sessionAwaits)
        .where(and(eq(sessionAwaits.sessionId, input.sessionId), eq(sessionAwaits.status, 'pending')))
        .orderBy(asc(sessionAwaits.createdAt), asc(sessionAwaits.waitId));
    return rows.map((row) => waitFromRow(waitRowSchema.parse(row)));
}

function waitFromRow(row: z.infer<typeof waitRowSchema>): SessionPendingWait {
    switch (row.reason) {
        case 'approval':
            return {
                waitId: row.waitId,
                reason: row.reason,
                source: { kind: 'approval', approvalId: row.approvalId ?? row.sourceId },
            };
        case 'user_input':
            return { waitId: row.waitId, reason: row.reason, source: { kind: 'operator', inputId: row.sourceId } };
        case 'subagent': {
            const metadata = parseJson(row.metadataJson, waitMetadataSchema);
            return {
                waitId: row.waitId,
                reason: row.reason,
                source: {
                    kind: 'subagent',
                    jobId: row.jobId ?? row.sourceId,
                    mode: metadata?.mode ?? 'sync',
                    ...(row.childSessionId !== null ? { childSessionId: row.childSessionId } : {}),
                },
            };
        }
        default:
            return assertNever(row.reason);
    }
}

async function loadBackgroundJobs(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionBackgroundJob[]> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({
            jobId: asyncJobs.jobId,
            childSessionId: asyncJobs.childSessionId,
            status: asyncJobs.status,
            metadataJson: asyncJobs.metadataJson,
        })
        .from(asyncJobs)
        .where(eq(asyncJobs.parentSessionId, input.sessionId))
        .orderBy(asc(asyncJobs.jobId));
    return rows.map((row) => {
        const parsed = jobRowSchema.parse(row);
        const metadata = parseJson(parsed.metadataJson, jobMetadataSchema);
        return {
            jobId: parsed.jobId,
            blocking: metadata?.blocking === true,
            status: parsed.status,
            ...(parsed.childSessionId !== null ? { childSessionId: parsed.childSessionId } : {}),
        };
    });
}

async function loadAbortMarker(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<SessionAbortMarker> {
    if (await tableExists(input.client, 'session_events')) {
        const db = drizzleFromClient(input.client);
        const rows = await db
            .select({ type: sessionEvents.type })
            .from(sessionEvents)
            .where(
                and(
                    eq(sessionEvents.sessionId, input.sessionId),
                    inArray(sessionEvents.type, ['session.abort.completed', 'run.started']),
                ),
            )
            .orderBy(desc(sessionEvents.seq))
            .limit(1);
        const row = rows[0];
        if (row !== undefined) {
            return markerRowSchema.parse(row).type === 'session.abort.completed'
                ? { kind: 'operator_aborted' }
                : { kind: 'none' };
        }
    }
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ metadataJson: sessions.metadataJson })
        .from(sessions)
        .where(eq(sessions.sessionId, input.sessionId));
    const row = rows[0];
    if (row === undefined) return { kind: 'none' };
    const metadata = parseJson(sessionMetadataRowSchema.parse(row).metadataJson, abortMetadataSchema);
    return metadata?.abortMarkerAt !== undefined ? { kind: 'operator_aborted' } : { kind: 'none' };
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
    // sqlite_master is catalog metadata — keep raw execute (not business DML/DQL).
    const result = await client.execute({
        sql: 'SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1',
        args: ['table', tableName],
    });
    return result.rows.length > 0;
}

function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | undefined {
    if (raw === null) return undefined;
    try {
        const parsed: unknown = JSON.parse(raw);
        const result = schema.safeParse(parsed);
        return result.success ? result.data : undefined;
    } catch {
        return undefined;
    }
}

function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
