import type { Delivery } from '@mission-control/protocol';
import { z } from 'zod';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql.js';
import { deriveSessionLifecycleFromSql } from '../memory/session-lifecycle-sql-authorities.js';
import { openCanonicalRuntimeDb } from './local-runtime-db.js';
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
export type SqlSessionInputDeliveryRecord = SessionInputRecord & {
    readonly status: SqlSessionInputStatus;
};

export type SqlSessionInputDeliveryOptions = {
    readonly blocking?: boolean;
};

export class SqlSessionInputDelivery {
    private constructor(private readonly runtime: LocalLibsqlDb) {}

    static async open(root: string): Promise<SqlSessionInputDelivery> {
        const { runtime } = await openCanonicalRuntimeDb({ dataDir: root, legacyRoots: [root] });
        return new SqlSessionInputDelivery(runtime);
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
        return deriveSessionLifecycleFromSql({ client: this.runtime.client, sessionId });
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

function waitIdForInput(inputId: string): string {
    return `input_wait_${inputId}`;
}
