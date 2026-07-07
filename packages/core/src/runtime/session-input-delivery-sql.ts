import type { Delivery } from '@mission-control/protocol';
import { z } from 'zod';
import { runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import {
    ensurePublicSessionRow,
    loadSessionActiveRuns,
    loadSessionTerminalEvent,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql.js';
import { deriveSessionLifecycle, type SessionPendingWait } from '../memory/session-status-derivation.js';
import { openRuntimeLocalDb } from './local-runtime-db.js';
import type { SessionInputRecord } from './session-input-delivery.js';

const inputStatusSchema = z.enum(['pending', 'admitted', 'promoted', 'cancelled']);
type SqlSessionInputStatus = z.infer<typeof inputStatusSchema>;

const inputRowSchema = z.object({
    input_id: z.string(),
    prompt: z.string(),
    delivery: z.enum(['steer', 'queue']),
    status: inputStatusSchema,
    admitted_seq: z.number().nullable(),
});

const countRowSchema = z.object({ count: z.number() });
const seqRowSchema = z.object({ next_seq: z.number() });
const waitRowSchema = z.object({
    wait_id: z.string(),
    reason: z.enum(['approval', 'user_input', 'subagent']),
    source_id: z.string(),
    approval_id: z.string().nullable(),
    job_id: z.string().nullable(),
    child_session_id: z.string().nullable(),
});

export type SqlSessionInputDeliveryRecord = SessionInputRecord & {
    readonly status: SqlSessionInputStatus;
};

export type SqlSessionInputDeliveryOptions = {
    readonly blocking?: boolean;
};

export class SqlSessionInputDelivery {
    private constructor(private readonly runtime: Awaited<ReturnType<typeof openRuntimeLocalDb>>) {}

    static async open(root: string): Promise<SqlSessionInputDelivery> {
        return new SqlSessionInputDelivery(await openRuntimeLocalDb(root));
    }

    async admitInput(
        sessionId: string,
        input: { readonly inputId: string; readonly prompt: string },
        delivery: Delivery,
        options: SqlSessionInputDeliveryOptions = {},
    ): Promise<SqlSessionInputDeliveryRecord> {
        return runLocalLibsqlWrite(this.runtime, async () => {
            await this.ensureSession(sessionId);
            const now = new Date().toISOString();
            const seq = await this.nextAdmittedSeq(sessionId);
            await this.runtime.client.execute({
                sql:
                    'INSERT INTO session_inputs (input_id, session_id, delivery, status, prompt, admitted_seq, created_at, admitted_at) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                args: [input.inputId, sessionId, delivery, 'admitted', input.prompt, seq, now, now],
            });
            if (options.blocking === true) {
                await this.recordUserInputWait(sessionId, input.inputId, now);
            }
            return {
                inputId: input.inputId,
                prompt: input.prompt,
                delivery,
                admittedAt: seq,
                status: 'admitted',
            };
        });
    }

    async promoteSteers(sessionId: string): Promise<readonly SqlSessionInputDeliveryRecord[]> {
        const records = await this.listAdmitted(sessionId, 'steer');
        for (const record of records) {
            await this.markPromoted(record.inputId, sessionId);
        }
        return records.map((record) => ({ ...record, status: 'promoted' }));
    }

    async promoteNextQueued(sessionId: string): Promise<SqlSessionInputDeliveryRecord | undefined> {
        const records = await this.listAdmitted(sessionId, 'queue');
        const next = records[0];
        if (next === undefined) {
            return undefined;
        }
        await this.markPromoted(next.inputId, sessionId);
        return { ...next, status: 'promoted' };
    }

    async pendingSteerCount(sessionId: string): Promise<number> {
        return this.pendingCount(sessionId, 'steer');
    }

    async pendingQueuedCount(sessionId: string): Promise<number> {
        return this.pendingCount(sessionId, 'queue');
    }

    async listInputs(sessionId: string): Promise<readonly SqlSessionInputDeliveryRecord[]> {
        const result = await this.runtime.client.execute({
            sql:
                'SELECT input_id, prompt, delivery, status, admitted_seq FROM session_inputs ' +
                'WHERE session_id = ? ORDER BY admitted_seq, input_id',
            args: [sessionId],
        });
        return result.rows.map(rowToInputRecord);
    }

    async deriveLifecycle(sessionId: string) {
        return deriveSessionLifecycle({
            terminalEvent: await loadSessionTerminalEvent({ client: this.runtime.client, sessionId }),
            activeRuns: await loadSessionActiveRuns({ client: this.runtime.client, sessionId }),
            pendingWaits: await this.pendingWaits(sessionId),
            backgroundJobs: [],
        });
    }

    close(): void {
        this.runtime.close();
    }

    private async ensureSession(sessionId: string): Promise<void> {
        const now = new Date().toISOString();
        await ensurePublicSessionRow({ client: this.runtime.client, sessionId, now });
    }

    private async nextAdmittedSeq(sessionId: string): Promise<number> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT COALESCE(MAX(admitted_seq), -1) + 1 AS next_seq FROM session_inputs WHERE session_id = ?',
            args: [sessionId],
        });
        return seqRowSchema.parse(result.rows[0]).next_seq;
    }

    private async listAdmitted(
        sessionId: string,
        delivery: Delivery,
    ): Promise<readonly SqlSessionInputDeliveryRecord[]> {
        const result = await this.runtime.client.execute({
            sql:
                'SELECT input_id, prompt, delivery, status, admitted_seq FROM session_inputs ' +
                'WHERE session_id = ? AND delivery = ? AND status = ? ORDER BY admitted_seq, input_id',
            args: [sessionId, delivery, 'admitted'],
        });
        return result.rows.map(rowToInputRecord);
    }

    private async markPromoted(inputId: string, sessionId: string): Promise<void> {
        await runLocalLibsqlWrite(this.runtime, async () => {
            const now = new Date().toISOString();
            const promotedSeq = await this.nextPromotedSeq(sessionId);
            await this.runtime.client.batch(
                [
                    {
                        sql:
                            'UPDATE session_inputs SET status = ?, promoted_seq = ?, promoted_at = ? ' +
                            'WHERE input_id = ? AND session_id = ?',
                        args: ['promoted', promotedSeq, now, inputId, sessionId],
                    },
                    {
                        sql:
                            'UPDATE session_awaits SET status = ?, resolved_at = ? ' +
                            'WHERE wait_id = ? AND session_id = ? AND status = ?',
                        args: ['resolved', now, waitIdForInput(inputId), sessionId, 'pending'],
                    },
                ],
                'write',
            );
            await refreshSessionAwaitingFromPendingWaits({ client: this.runtime.client, sessionId, now });
        });
    }

    private async nextPromotedSeq(sessionId: string): Promise<number> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT COALESCE(MAX(promoted_seq), -1) + 1 AS next_seq FROM session_inputs WHERE session_id = ?',
            args: [sessionId],
        });
        return seqRowSchema.parse(result.rows[0]).next_seq;
    }

    private async pendingCount(sessionId: string, delivery: Delivery): Promise<number> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT COUNT(*) AS count FROM session_inputs WHERE session_id = ? AND delivery = ? AND status = ?',
            args: [sessionId, delivery, 'admitted'],
        });
        return countRowSchema.parse(result.rows[0]).count;
    }

    private async recordUserInputWait(sessionId: string, inputId: string, now: string): Promise<void> {
        const waitId = waitIdForInput(inputId);
        await this.runtime.client.execute({
            sql:
                'INSERT INTO session_awaits (wait_id, session_id, reason, source_kind, source_id, status, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(wait_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at, ' +
                'resolved_at = NULL, cancelled_at = NULL',
            args: [waitId, sessionId, 'user_input', 'operator', inputId, 'pending', now],
        });
        await persistSessionAwaiting({
            client: this.runtime.client,
            sessionId,
            reason: 'user_input',
            waitId,
            now,
        });
    }

    private async pendingWaits(sessionId: string): Promise<readonly SessionPendingWait[]> {
        const result = await this.runtime.client.execute({
            sql:
                'SELECT wait_id, reason, source_id, approval_id, job_id, child_session_id ' +
                'FROM session_awaits WHERE session_id = ? AND status = ? ORDER BY created_at, wait_id',
            args: [sessionId, 'pending'],
        });
        return result.rows.map(rowToPendingWait);
    }
}

function rowToInputRecord(row: unknown): SqlSessionInputDeliveryRecord {
    const parsed = inputRowSchema.parse(row);
    return {
        inputId: parsed.input_id,
        prompt: parsed.prompt,
        delivery: parsed.delivery,
        admittedAt: parsed.admitted_seq ?? -1,
        status: parsed.status,
    };
}

function rowToPendingWait(row: unknown): SessionPendingWait {
    const parsed = waitRowSchema.parse(row);
    switch (parsed.reason) {
        case 'approval':
            return {
                waitId: parsed.wait_id,
                reason: parsed.reason,
                source: { kind: 'approval', approvalId: parsed.approval_id ?? parsed.source_id },
            };
        case 'user_input':
            return {
                waitId: parsed.wait_id,
                reason: parsed.reason,
                source: { kind: 'operator', inputId: parsed.source_id },
            };
        case 'subagent':
            return {
                waitId: parsed.wait_id,
                reason: parsed.reason,
                source: {
                    kind: 'subagent',
                    jobId: parsed.job_id ?? parsed.source_id,
                    mode: 'sync',
                    ...(parsed.child_session_id !== null ? { childSessionId: parsed.child_session_id } : {}),
                },
            };
        default:
            return assertNever(parsed.reason);
    }
}

function waitIdForInput(inputId: string): string {
    return `input_wait_${inputId}`;
}

function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
