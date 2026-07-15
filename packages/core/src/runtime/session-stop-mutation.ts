import type { Client } from '@libsql/client';
import type { SessionAbortAffectedCounts } from '@mission-control/protocol';
import { z } from 'zod';
import { refreshSessionAwaitingFromPendingWaits } from '../memory/session-awaiting-sql';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { updateRunStatusWithClient } from './mission-run/run-store';

const inputRowSchema = z.object({ input_id: z.string(), delivery: z.enum(['steer', 'queue']) });
const approvalRowSchema = z.object({ approval_id: z.string() });
const idRowSchema = z.object({ id: z.string() });
const jobRowSchema = z.object({ job_id: z.string(), status: z.enum(['queued', 'running']) });
const statusRowSchema = z.object({ status: z.enum(['idle', 'running', 'awaiting', 'stopped', 'failed']) });

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
    const result = await client.execute({ sql: 'SELECT status FROM sessions WHERE session_id = ?', args: [sessionId] });
    const row = result.rows[0];
    if (row === undefined) return 'missing';
    const status = statusRowSchema.parse(row).status;
    return status === 'stopped' || status === 'failed' ? 'terminal' : 'active';
}

export async function applyStopMutation(input: StopMutationInput): Promise<StopMutationResult> {
    const [activeRunIds, inputs, approvalIds, waitIds, missionRunIds, jobs, toolCallIds] = await Promise.all([
        selectIds(
            input.client,
            `SELECT current.run_id AS id FROM session_projection_runs current
             WHERE current.session_id = ? AND current.run_id IS NOT NULL
               AND current.sequence = (SELECT MAX(latest.sequence) FROM session_projection_runs latest
                   WHERE latest.session_id = current.session_id AND latest.run_id = current.run_id)
               AND current.state IN ('running','blocked_on_approval') ORDER BY current.run_id`,
            [input.sessionId],
        ),
        selectInputs(input.client, input.sessionId),
        selectApprovalIds(input.client, input.sessionId),
        selectIds(
            input.client,
            "SELECT wait_id AS id FROM session_awaits WHERE session_id = ? AND status = 'pending' ORDER BY wait_id",
            [input.sessionId],
        ),
        selectIds(
            input.client,
            "SELECT run_id AS id FROM mission_runs WHERE session_id = ? AND status IN ('pending','running','blocked') ORDER BY run_id",
            [input.sessionId],
        ),
        selectJobs(input.client, input.sessionId),
        selectIds(
            input.client,
            "SELECT tool_call_id AS id FROM tool_calls WHERE session_id = ? AND status IN ('pending','running') ORDER BY tool_call_id",
            [input.sessionId],
        ),
    ]);

    await input.client.execute({
        sql: "UPDATE session_inputs SET status = 'cancelled', cancelled_at = ? WHERE session_id = ? AND status IN ('pending','admitted')",
        args: [input.timestamp, input.sessionId],
    });
    await input.client.execute({
        sql: "UPDATE session_awaits SET status = 'cancelled', cancelled_at = ? WHERE session_id = ? AND status = 'pending'",
        args: [input.timestamp, input.sessionId],
    });
    await input.client.execute({
        sql: "UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE session_id = ? AND status = 'pending'",
        args: [input.timestamp, input.sessionId],
    });
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
    await input.client.execute({
        sql:
            "UPDATE async_jobs SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ? " +
            "WHERE parent_session_id = ? AND status = 'queued'",
        args: [input.timestamp, 'operator_aborted', input.sessionId],
    });
    await input.client.execute({
        sql: "UPDATE async_jobs SET cancellation_reason = ? WHERE parent_session_id = ? AND status = 'running'",
        args: ['operator_aborted', input.sessionId],
    });
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
    const result = await client.execute({ sql: 'SELECT status FROM sessions WHERE session_id = ?', args: [sessionId] });
    const row = result.rows[0];
    return row === undefined ? undefined : statusRowSchema.parse(row).status;
}

async function selectIds(client: Client, sql: string, args: readonly string[]): Promise<readonly string[]> {
    const result = await client.execute({ sql, args: [...args] });
    return result.rows.map((row) => idRowSchema.parse(row).id);
}

async function selectInputs(
    client: Client,
    sessionId: string,
): Promise<readonly { readonly inputId: string; readonly delivery: 'steer' | 'queue' }[]> {
    const result = await client.execute({
        sql: "SELECT input_id, delivery FROM session_inputs WHERE session_id = ? AND status IN ('pending','admitted') ORDER BY input_id",
        args: [sessionId],
    });
    return result.rows.map((row) => {
        const parsed = inputRowSchema.parse(row);
        return { inputId: parsed.input_id, delivery: parsed.delivery };
    });
}

async function selectApprovalIds(client: Client, sessionId: string): Promise<readonly string[]> {
    const result = await client.execute({
        sql: "SELECT approval_id FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY approval_id",
        args: [sessionId],
    });
    return result.rows.map((row) => approvalRowSchema.parse(row).approval_id);
}

async function selectJobs(client: Client, sessionId: string): Promise<readonly z.infer<typeof jobRowSchema>[]> {
    const result = await client.execute({
        sql: "SELECT job_id, status FROM async_jobs WHERE parent_session_id = ? AND status IN ('queued','running') ORDER BY job_id",
        args: [sessionId],
    });
    return result.rows.map((row) => jobRowSchema.parse(row));
}
