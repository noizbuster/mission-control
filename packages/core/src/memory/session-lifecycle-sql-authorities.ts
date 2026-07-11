import type { Client } from '@libsql/client';
import { z } from 'zod';
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
} from './session-status-derivation.js';

const sessionRowSchema = z.object({
    status: z.enum(['idle', 'running', 'awaiting', 'stopped', 'failed']),
    stopped_at: z.string().nullable(),
    failed_at: z.string().nullable(),
});
const idRowSchema = z.object({ run_id: z.string() });
const missionRunRowSchema = z.object({ run_id: z.string(), status: z.enum(['pending', 'running', 'blocked']) });
const inputRowSchema = z.object({ input_id: z.string() });
const waitRowSchema = z.object({
    wait_id: z.string(),
    reason: z.enum(['approval', 'user_input', 'subagent']),
    source_id: z.string(),
    approval_id: z.string().nullable(),
    job_id: z.string().nullable(),
    child_session_id: z.string().nullable(),
    metadata_json: z.string().nullable(),
});
const jobRowSchema = z.object({
    job_id: z.string(),
    child_session_id: z.string().nullable(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    metadata_json: z.string().nullable(),
});
const markerRowSchema = z.object({ type: z.enum(['session.abort.completed', 'run.started']) });
const sessionMetadataRowSchema = z.object({ metadata_json: z.string().nullable() });
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
    const result = await input.client.execute({
        sql: 'SELECT status, stopped_at, failed_at FROM sessions WHERE session_id = ?',
        args: [input.sessionId],
    });
    const row = result.rows[0];
    if (row === undefined) return { kind: 'none' };
    const session = sessionRowSchema.parse(row);
    if (session.status === 'failed' || session.failed_at !== null) return { kind: 'failed' };
    if (session.status === 'stopped' || session.stopped_at !== null) return { kind: 'stopped' };
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
    const result = await input.client.execute({
        sql: `
            SELECT current.run_id
            FROM session_projection_runs current
            WHERE current.session_id = ? AND current.run_id IS NOT NULL
              AND current.sequence = (
                  SELECT MAX(latest.sequence) FROM session_projection_runs latest
                  WHERE latest.session_id = current.session_id AND latest.run_id = current.run_id
              )
              AND current.state IN (?, ?)
            ORDER BY current.run_id
        `,
        args: [input.sessionId, 'running', 'blocked_on_approval'],
    });
    return result.rows.map((row) => ({ runId: idRowSchema.parse(row).run_id }));
}

async function loadSessionMissionRuns(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionMissionRun[]> {
    if (!(await tableExists(input.client, 'mission_runs'))) return [];
    const result = await input.client.execute({
        sql: 'SELECT run_id, status FROM mission_runs WHERE session_id = ? AND status IN (?, ?, ?) ORDER BY run_id',
        args: [input.sessionId, 'pending', 'running', 'blocked'],
    });
    return result.rows.map((row) => {
        const parsed = missionRunRowSchema.parse(row);
        return { runId: parsed.run_id, status: parsed.status };
    });
}

async function loadPendingInputs(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionPendingInput[]> {
    if (!(await tableExists(input.client, 'session_inputs'))) return [];
    const result = await input.client.execute({
        sql: 'SELECT input_id FROM session_inputs WHERE session_id = ? AND status IN (?, ?) ORDER BY input_id',
        args: [input.sessionId, 'pending', 'admitted'],
    });
    return result.rows.map((row) => ({ inputId: inputRowSchema.parse(row).input_id }));
}

async function loadPendingWaits(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionPendingWait[]> {
    const result = await input.client.execute({
        sql: `
            SELECT wait_id, reason, source_id, approval_id, job_id, child_session_id, metadata_json
            FROM session_awaits WHERE session_id = ? AND status = ? ORDER BY created_at, wait_id
        `,
        args: [input.sessionId, 'pending'],
    });
    return result.rows.map((row) => waitFromRow(waitRowSchema.parse(row)));
}

function waitFromRow(row: z.infer<typeof waitRowSchema>): SessionPendingWait {
    switch (row.reason) {
        case 'approval':
            return {
                waitId: row.wait_id,
                reason: row.reason,
                source: { kind: 'approval', approvalId: row.approval_id ?? row.source_id },
            };
        case 'user_input':
            return { waitId: row.wait_id, reason: row.reason, source: { kind: 'operator', inputId: row.source_id } };
        case 'subagent': {
            const metadata = parseJson(row.metadata_json, waitMetadataSchema);
            return {
                waitId: row.wait_id,
                reason: row.reason,
                source: {
                    kind: 'subagent',
                    jobId: row.job_id ?? row.source_id,
                    mode: metadata?.mode ?? 'sync',
                    ...(row.child_session_id !== null ? { childSessionId: row.child_session_id } : {}),
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
    const result = await input.client.execute({
        sql: 'SELECT job_id, child_session_id, status, metadata_json FROM async_jobs WHERE parent_session_id = ? ORDER BY job_id',
        args: [input.sessionId],
    });
    return result.rows.map((row) => {
        const parsed = jobRowSchema.parse(row);
        const metadata = parseJson(parsed.metadata_json, jobMetadataSchema);
        return {
            jobId: parsed.job_id,
            blocking: metadata?.blocking === true,
            status: parsed.status,
            ...(parsed.child_session_id !== null ? { childSessionId: parsed.child_session_id } : {}),
        };
    });
}

async function loadAbortMarker(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<SessionAbortMarker> {
    if (await tableExists(input.client, 'session_events')) {
        const result = await input.client.execute({
            sql: 'SELECT type FROM session_events WHERE session_id = ? AND type IN (?, ?) ORDER BY seq DESC LIMIT 1',
            args: [input.sessionId, 'session.abort.completed', 'run.started'],
        });
        const row = result.rows[0];
        if (row !== undefined) {
            return markerRowSchema.parse(row).type === 'session.abort.completed'
                ? { kind: 'operator_aborted' }
                : { kind: 'none' };
        }
    }
    const result = await input.client.execute({
        sql: 'SELECT metadata_json FROM sessions WHERE session_id = ?',
        args: [input.sessionId],
    });
    const row = result.rows[0];
    if (row === undefined) return { kind: 'none' };
    const metadata = parseJson(sessionMetadataRowSchema.parse(row).metadata_json, abortMetadataSchema);
    return metadata?.abortMarkerAt !== undefined ? { kind: 'operator_aborted' } : { kind: 'none' };
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
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
