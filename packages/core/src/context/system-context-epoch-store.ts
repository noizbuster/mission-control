import { asc, eq } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { openMissionControlDb } from '../db/mission-control-db';
import { contextEpochs, sessions } from '../db/schema';

export type ContextEpochRecordInput = {
    readonly sessionId: string;
    readonly epoch: number;
    readonly sourceId: string;
    readonly baselineText?: string;
    readonly updateText?: string;
    readonly metadataJson?: string;
};

export type ContextEpochRecord = {
    readonly contextEpochId: string;
    readonly sessionId: string;
    readonly epoch: number;
    readonly sourceId: string;
    readonly baselineText?: string;
    readonly updateText?: string;
    readonly createdAt: string;
    readonly metadataJson?: string;
};

export class SqlContextEpochStore {
    private constructor(private readonly runtime: LocalLibsqlDb) {}

    static async open(input: { readonly dataDir: string }): Promise<SqlContextEpochStore> {
        return new SqlContextEpochStore(await openMissionControlDb(input));
    }

    static fromRuntime(runtime: LocalLibsqlDb): SqlContextEpochStore {
        return new SqlContextEpochStore(runtime);
    }

    async recordEpoch(input: ContextEpochRecordInput): Promise<ContextEpochRecord> {
        return runLocalLibsqlWrite(this.runtime, async () => {
            await this.ensureSession(input.sessionId);
            const now = new Date().toISOString();
            const record: ContextEpochRecord = {
                contextEpochId: contextEpochId(input),
                sessionId: input.sessionId,
                epoch: input.epoch,
                sourceId: input.sourceId,
                ...(input.baselineText !== undefined ? { baselineText: input.baselineText } : {}),
                ...(input.updateText !== undefined ? { updateText: input.updateText } : {}),
                createdAt: now,
                ...(input.metadataJson !== undefined ? { metadataJson: input.metadataJson } : {}),
            };
            const db = drizzleFromClient(this.runtime.client);
            await db
                .insert(contextEpochs)
                .values({
                    contextEpochId: record.contextEpochId,
                    sessionId: record.sessionId,
                    epoch: record.epoch,
                    sourceId: record.sourceId,
                    baselineText: record.baselineText ?? null,
                    updateText: record.updateText ?? null,
                    createdAt: record.createdAt,
                    metadataJson: record.metadataJson ?? null,
                })
                .onConflictDoUpdate({
                    target: [contextEpochs.sessionId, contextEpochs.epoch, contextEpochs.sourceId],
                    set: {
                        baselineText: record.baselineText ?? null,
                        updateText: record.updateText ?? null,
                        createdAt: record.createdAt,
                        metadataJson: record.metadataJson ?? null,
                    },
                });
            return record;
        });
    }

    async listEpochs(sessionId: string): Promise<readonly ContextEpochRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(contextEpochs)
            .where(eq(contextEpochs.sessionId, sessionId))
            .orderBy(asc(contextEpochs.epoch), asc(contextEpochs.sourceId));
        return rows.map((row) => ({
            contextEpochId: row.contextEpochId,
            sessionId: row.sessionId,
            epoch: row.epoch,
            sourceId: row.sourceId,
            ...(row.baselineText !== null ? { baselineText: row.baselineText } : {}),
            ...(row.updateText !== null ? { updateText: row.updateText } : {}),
            createdAt: row.createdAt,
            ...(row.metadataJson !== null ? { metadataJson: row.metadataJson } : {}),
        }));
    }

    close(): void {
        this.runtime.close();
    }

    private async ensureSession(sessionId: string): Promise<void> {
        const now = new Date().toISOString();
        const db = drizzleFromClient(this.runtime.client);
        await db
            .insert(sessions)
            .values({
                sessionId,
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                lastActivityAt: now,
            })
            .onConflictDoNothing({ target: sessions.sessionId });
    }
}

function contextEpochId(input: Pick<ContextEpochRecordInput, 'sessionId' | 'epoch' | 'sourceId'>): string {
    return `${input.sessionId}:${input.epoch}:${input.sourceId}`;
}
