import type { Client } from '@libsql/client';
import type { SessionAbortAffectedCounts } from '@mission-control/protocol';
import { and, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { drizzleFromClient } from '../db/drizzle-client';
import {
    approvals,
    asyncJobs,
    missionRuns,
    sessionAwaits,
    sessionInputs,
    sessionProjectionRuns,
    sessions,
    toolCalls,
} from '../db/schema';
import { refreshSessionAwaitingFromPendingWaits } from '../memory/session-awaiting-sql';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { updateRunStatusWithClient } from './mission-run/run-store';

export type StopMutationInput = {
    readonly client: Client;
    readonly sessionId: string;
    readonly timestamp: string;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export type StopMutationResult = {
    readonly activeRunIds: readonly string[];
    readonly inputs: readonly { readonly inputId: string; readonly delivery: 'steer' | 'queue' }[];
    readonly approvalIds: readonly string[];
    readonly missionRunIds: readonly string[];
    readonly affected: SessionAbortAffectedCounts;
};

export async function readSessionTerminalStatus(
    client: Client,
    sessionId: string,
): Promise<'missing' | 'active' | 'terminal'> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);
    const row = rows[0];
    if (row === undefined) return 'missing';
    return row.status === 'stopped' || row.status === 'failed' ? 'terminal' : 'active';
}

export async function applyStopMutation(input: StopMutationInput): Promise<StopMutationResult> {
    const db = drizzleFromClient(input.client);
    const [activeRunIds, inputs, approvalIds, waitIds, missionRunIds, jobs, toolCallIds] = await Promise.all([
        selectActiveProjectionRunIds(db, input.sessionId),
        selectInputs(db, input.sessionId),
        selectApprovalIds(db, input.sessionId),
        selectPendingWaitIds(db, input.sessionId),
        selectMissionRunIds(db, input.sessionId),
        selectJobs(db, input.sessionId),
        selectToolCallIds(db, input.sessionId),
    ]);

    await db
        .update(sessionInputs)
        .set({ status: 'cancelled', cancelledAt: input.timestamp })
        .where(and(eq(sessionInputs.sessionId, input.sessionId), inArray(sessionInputs.status, ['pending', 'admitted'])));
    await db
        .update(sessionAwaits)
        .set({ status: 'cancelled', cancelledAt: input.timestamp })
        .where(and(eq(sessionAwaits.sessionId, input.sessionId), eq(sessionAwaits.status, 'pending')));
    await db
        .update(approvals)
        .set({ status: 'cancelled', decidedAt: input.timestamp })
        .where(and(eq(approvals.sessionId, input.sessionId), eq(approvals.status, 'pending')));
    for (const runId of missionRunIds) {
        await updateRunStatusWithClient(
            input.client,
            runId,
            'cancelled',
            { terminalReason: 'operator_aborted' },
            {
                now: () => input.timestamp,
                ...(input.observabilityRedactor !== undefined
                    ? { observabilityRedactor: input.observabilityRedactor }
                    : {}),
            },
        );
    }
    await db
        .update(asyncJobs)
        .set({ status: 'cancelled', cancelledAt: input.timestamp, cancellationReason: 'operator_aborted' })
        .where(and(eq(asyncJobs.parentSessionId, input.sessionId), eq(asyncJobs.status, 'queued')));
    await db
        .update(asyncJobs)
        .set({ cancellationReason: 'operator_aborted' })
        .where(and(eq(asyncJobs.parentSessionId, input.sessionId), eq(asyncJobs.status, 'running')));
    await refreshSessionAwaitingFromPendingWaits({
        client: input.client,
        sessionId: input.sessionId,
        now: input.timestamp,
    });

    return {
        activeRunIds,
        inputs,
        approvalIds,
        missionRunIds,
        affected: {
            runs: activeRunIds.length,
            approvals: approvalIds.length,
            sessionAwaits: waitIds.length,
            sessionInputs: inputs.length,
            missionRuns: missionRunIds.length,
            asyncJobs: jobs.length,
            toolCalls: toolCallIds.length,
        },
    };
}

export async function refreshStoppedSession(client: Client, sessionId: string, timestamp: string): Promise<void> {
    await refreshSessionAwaitingFromPendingWaits({ client, sessionId, now: timestamp });
}

export async function readSessionStatus(client: Client, sessionId: string): Promise<string | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);
    return rows[0]?.status;
}

type Db = ReturnType<typeof drizzleFromClient>;

async function selectActiveProjectionRunIds(db: Db, sessionId: string): Promise<readonly string[]> {
    const latest = alias(sessionProjectionRuns, 'latest');
    const maxSequence = db
        .select({ value: max(latest.sequence) })
        .from(latest)
        .where(and(eq(latest.sessionId, sessionProjectionRuns.sessionId), eq(latest.runId, sessionProjectionRuns.runId)));
    const rows = await db
        .select({ id: sessionProjectionRuns.runId })
        .from(sessionProjectionRuns)
        .where(
            and(
                eq(sessionProjectionRuns.sessionId, sessionId),
                isNotNull(sessionProjectionRuns.runId),
                eq(sessionProjectionRuns.sequence, maxSequence),
                inArray(sessionProjectionRuns.state, ['running', 'blocked_on_approval']),
            ),
        )
        .orderBy(sessionProjectionRuns.runId);
    return rows.map((row) => row.id).filter((id): id is string => id !== null);
}

async function selectPendingWaitIds(db: Db, sessionId: string): Promise<readonly string[]> {
    const rows = await db
        .select({ id: sessionAwaits.waitId })
        .from(sessionAwaits)
        .where(and(eq(sessionAwaits.sessionId, sessionId), eq(sessionAwaits.status, 'pending')))
        .orderBy(sessionAwaits.waitId);
    return rows.map((row) => row.id);
}

async function selectMissionRunIds(db: Db, sessionId: string): Promise<readonly string[]> {
    const rows = await db
        .select({ id: missionRuns.runId })
        .from(missionRuns)
        .where(
            and(
                eq(missionRuns.sessionId, sessionId),
                inArray(missionRuns.status, ['pending', 'running', 'blocked']),
            ),
        )
        .orderBy(missionRuns.runId);
    return rows.map((row) => row.id);
}

async function selectToolCallIds(db: Db, sessionId: string): Promise<readonly string[]> {
    const rows = await db
        .select({ id: toolCalls.toolCallId })
        .from(toolCalls)
        .where(and(eq(toolCalls.sessionId, sessionId), inArray(toolCalls.status, ['pending', 'running'])))
        .orderBy(toolCalls.toolCallId);
    return rows.map((row) => row.id);
}

async function selectInputs(
    db: Db,
    sessionId: string,
): Promise<readonly { readonly inputId: string; readonly delivery: 'steer' | 'queue' }[]> {
    const rows = await db
        .select({ inputId: sessionInputs.inputId, delivery: sessionInputs.delivery })
        .from(sessionInputs)
        .where(and(eq(sessionInputs.sessionId, sessionId), inArray(sessionInputs.status, ['pending', 'admitted'])))
        .orderBy(sessionInputs.inputId);
    return rows.map((row) => ({ inputId: row.inputId, delivery: row.delivery }));
}

async function selectApprovalIds(db: Db, sessionId: string): Promise<readonly string[]> {
    const rows = await db
        .select({ approvalId: approvals.approvalId })
        .from(approvals)
        .where(and(eq(approvals.sessionId, sessionId), eq(approvals.status, 'pending')))
        .orderBy(approvals.approvalId);
    return rows.map((row) => row.approvalId);
}

async function selectJobs(
    db: Db,
    sessionId: string,
): Promise<readonly { readonly job_id: string; readonly status: 'queued' | 'running' }[]> {
    const rows = await db
        .select({ jobId: asyncJobs.jobId, status: asyncJobs.status })
        .from(asyncJobs)
        .where(and(eq(asyncJobs.parentSessionId, sessionId), inArray(asyncJobs.status, ['queued', 'running'])))
        .orderBy(asyncJobs.jobId);
    return rows.map((row) => ({
        job_id: row.jobId,
        status: row.status as 'queued' | 'running',
    }));
}
