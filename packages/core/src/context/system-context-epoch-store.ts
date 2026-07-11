import { z } from 'zod';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db.js';

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

const epochRowSchema = z.object({
    context_epoch_id: z.string(),
    session_id: z.string(),
    epoch: z.number(),
    source_id: z.string(),
    baseline_text: z.string().nullable(),
    update_text: z.string().nullable(),
    created_at: z.string(),
    metadata_json: z.string().nullable(),
});

export class SqlContextEpochStore {
    private constructor(private readonly runtime: LocalLibsqlDb) {}

    static async open(root: string): Promise<SqlContextEpochStore> {
        const { runtime } = await openCanonicalRuntimeDb({ dataDir: root, legacyRoots: [root] });
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
            await this.runtime.client.execute({
                sql:
                    'INSERT INTO context_epochs (context_epoch_id, session_id, epoch, source_id, baseline_text, update_text, created_at, metadata_json) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
                    'ON CONFLICT(session_id, epoch, source_id) DO UPDATE SET baseline_text = excluded.baseline_text, ' +
                    'update_text = excluded.update_text, created_at = excluded.created_at, metadata_json = excluded.metadata_json',
                args: [
                    record.contextEpochId,
                    record.sessionId,
                    record.epoch,
                    record.sourceId,
                    record.baselineText ?? null,
                    record.updateText ?? null,
                    record.createdAt,
                    record.metadataJson ?? null,
                ],
            });
            return record;
        });
    }

    async listEpochs(sessionId: string): Promise<readonly ContextEpochRecord[]> {
        const result = await this.runtime.client.execute({
            sql:
                'SELECT context_epoch_id, session_id, epoch, source_id, baseline_text, update_text, created_at, metadata_json ' +
                'FROM context_epochs WHERE session_id = ? ORDER BY epoch, source_id',
            args: [sessionId],
        });
        return result.rows.map(rowToContextEpochRecord);
    }

    close(): void {
        this.runtime.close();
    }

    private async ensureSession(sessionId: string): Promise<void> {
        const now = new Date().toISOString();
        await this.runtime.client.execute({
            sql:
                'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(session_id) DO NOTHING',
            args: [sessionId, 'idle', now, now, now],
        });
    }
}

function rowToContextEpochRecord(row: unknown): ContextEpochRecord {
    const parsed = epochRowSchema.parse(row);
    return {
        contextEpochId: parsed.context_epoch_id,
        sessionId: parsed.session_id,
        epoch: parsed.epoch,
        sourceId: parsed.source_id,
        ...(parsed.baseline_text !== null ? { baselineText: parsed.baseline_text } : {}),
        ...(parsed.update_text !== null ? { updateText: parsed.update_text } : {}),
        createdAt: parsed.created_at,
        ...(parsed.metadata_json !== null ? { metadataJson: parsed.metadata_json } : {}),
    };
}

function contextEpochId(input: Pick<ContextEpochRecordInput, 'sessionId' | 'epoch' | 'sourceId'>): string {
    return `${input.sessionId}:${input.epoch}:${input.sourceId}`;
}
