import type { Delivery } from '@mission-control/protocol';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import { openMissionControlDb } from '../db/mission-control-db';
import { sessionAwaits, sessionInputs } from '../db/schema';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql';
import { deriveSessionLifecycleFromSql } from '../memory/session-lifecycle-sql-authorities';
import type { SessionInputRecord } from './session-input-delivery';

const inputStatusSchema = z.enum(['pending', 'admitted', 'promoted', 'cancelled']);
type SqlSessionInputStatus = z.infer<typeof inputStatusSchema>;

const inputRowSchema = z.object({
    inputId: z.string(),
    prompt: z.string(),
    delivery: z.enum(['steer', 'queue']),
    status: inputStatusSchema,
    admittedSeq: z.number().nullable(),
});

const countRowSchema = z.object({ count: z.number() });
const seqRowSchema = z.object({ nextSeq: z.number() });
export type SqlSessionInputDeliveryRecord = SessionInputRecord & {
    readonly status: SqlSessionInputStatus;
};

export type SqlSessionInputDeliveryOptions = {
    readonly blocking?: boolean;
};

export class SqlSessionInputDelivery {
    private constructor(private readonly runtime: LocalLibsqlDb) {}

    static async open(input: { readonly dataDir: string }): Promise<SqlSessionInputDelivery> {
        const runtime = await openMissionControlDb({ dataDir: input.dataDir });
        return SqlSessionInputDelivery.fromRuntime(runtime);
    }

    static fromRuntime(runtime: LocalLibsqlDb): SqlSessionInputDelivery {
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
            const db = drizzleFromClient(this.runtime.client);
            await db.insert(sessionInputs).values({
                inputId: input.inputId,
                sessionId,
                delivery,
                status: 'admitted',
                prompt: input.prompt,
                admittedSeq: seq,
                createdAt: now,
                admittedAt: now,
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
        return runLocalLibsqlWrite(this.runtime, (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const records = await this.listAdmitted(sessionId, 'steer');
                const promoted: SqlSessionInputDeliveryRecord[] = [];
                for (const record of records) {
                    if (await this.markPromotedInOpenTransaction(record.inputId, sessionId)) {
                        promoted.push({ ...record, status: 'promoted' });
                    }
                }
                return promoted;
            }),
        );
    }

    async promoteNextQueued(sessionId: string): Promise<SqlSessionInputDeliveryRecord | undefined> {
        return runLocalLibsqlWrite(this.runtime, (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const records = await this.listAdmitted(sessionId, 'queue');
                const next = records[0];
                if (next === undefined) {
                    return undefined;
                }
                const promoted = await this.markPromotedInOpenTransaction(next.inputId, sessionId);
                return promoted ? { ...next, status: 'promoted' } : undefined;
            }),
        );
    }

    async pendingSteerCount(sessionId: string): Promise<number> {
        return this.pendingCount(sessionId, 'steer');
    }

    async pendingQueuedCount(sessionId: string): Promise<number> {
        return this.pendingCount(sessionId, 'queue');
    }

    async listInputs(sessionId: string): Promise<readonly SqlSessionInputDeliveryRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select({
                inputId: sessionInputs.inputId,
                prompt: sessionInputs.prompt,
                delivery: sessionInputs.delivery,
                status: sessionInputs.status,
                admittedSeq: sessionInputs.admittedSeq,
            })
            .from(sessionInputs)
            .where(eq(sessionInputs.sessionId, sessionId))
            .orderBy(asc(sessionInputs.admittedSeq), asc(sessionInputs.inputId));
        return rows.map(rowToInputRecord);
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
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select({
                nextSeq: sql`COALESCE(MAX(${sessionInputs.admittedSeq}), -1) + 1`.mapWith(Number),
            })
            .from(sessionInputs)
            .where(eq(sessionInputs.sessionId, sessionId));
        return seqRowSchema.parse(rows[0]).nextSeq;
    }

    private async listAdmitted(
        sessionId: string,
        delivery: Delivery,
    ): Promise<readonly SqlSessionInputDeliveryRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select({
                inputId: sessionInputs.inputId,
                prompt: sessionInputs.prompt,
                delivery: sessionInputs.delivery,
                status: sessionInputs.status,
                admittedSeq: sessionInputs.admittedSeq,
            })
            .from(sessionInputs)
            .where(
                and(
                    eq(sessionInputs.sessionId, sessionId),
                    eq(sessionInputs.delivery, delivery),
                    eq(sessionInputs.status, 'admitted'),
                ),
            )
            .orderBy(asc(sessionInputs.admittedSeq), asc(sessionInputs.inputId));
        return rows.map(rowToInputRecord);
    }

    private async markPromotedInOpenTransaction(inputId: string, sessionId: string): Promise<boolean> {
        const now = new Date().toISOString();
        const promotedSeq = await this.nextPromotedSeq(sessionId);
        const db = drizzleFromClient(this.runtime.client);
        const result = await db
            .update(sessionInputs)
            .set({
                status: 'promoted',
                promotedSeq,
                promotedAt: now,
            })
            .where(
                and(
                    eq(sessionInputs.inputId, inputId),
                    eq(sessionInputs.sessionId, sessionId),
                    eq(sessionInputs.status, 'admitted'),
                ),
            );
        if (result.rowsAffected !== 1) {
            return false;
        }
        await db
            .update(sessionAwaits)
            .set({
                status: 'resolved',
                resolvedAt: now,
            })
            .where(
                and(
                    eq(sessionAwaits.waitId, waitIdForInput(inputId)),
                    eq(sessionAwaits.sessionId, sessionId),
                    eq(sessionAwaits.status, 'pending'),
                ),
            );
        await refreshSessionAwaitingFromPendingWaits({ client: this.runtime.client, sessionId, now });
        return true;
    }

    private async nextPromotedSeq(sessionId: string): Promise<number> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select({
                nextSeq: sql`COALESCE(MAX(${sessionInputs.promotedSeq}), -1) + 1`.mapWith(Number),
            })
            .from(sessionInputs)
            .where(eq(sessionInputs.sessionId, sessionId));
        return seqRowSchema.parse(rows[0]).nextSeq;
    }

    private async pendingCount(sessionId: string, delivery: Delivery): Promise<number> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select({ count: count() })
            .from(sessionInputs)
            .where(
                and(
                    eq(sessionInputs.sessionId, sessionId),
                    eq(sessionInputs.delivery, delivery),
                    eq(sessionInputs.status, 'admitted'),
                ),
            );
        return countRowSchema.parse(rows[0]).count;
    }

    private async recordUserInputWait(sessionId: string, inputId: string, now: string): Promise<void> {
        const waitId = waitIdForInput(inputId);
        const db = drizzleFromClient(this.runtime.client);
        await db
            .insert(sessionAwaits)
            .values({
                waitId,
                sessionId,
                reason: 'user_input',
                sourceKind: 'operator',
                sourceId: inputId,
                status: 'pending',
                createdAt: now,
            })
            .onConflictDoUpdate({
                target: sessionAwaits.waitId,
                set: {
                    status: 'pending',
                    createdAt: now,
                    resolvedAt: null,
                    cancelledAt: null,
                },
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
        inputId: parsed.inputId,
        prompt: parsed.prompt,
        delivery: parsed.delivery,
        admittedAt: parsed.admittedSeq ?? -1,
        status: parsed.status,
    };
}

function waitIdForInput(inputId: string): string {
    return `input_wait_${inputId}`;
}
