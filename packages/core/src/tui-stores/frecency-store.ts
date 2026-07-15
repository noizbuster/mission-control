import { type TuiFrecencyRecord, TuiFrecencyRecordSchema } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { atomicWriteTextFile, jsonlText, parseJsonlRecords, readOptionalTextFile } from './store-file-io';
import { join } from 'node:path';

export const TUI_FRECENCY_MAX_ENTRIES = 500;

export type TuiFrecencyStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly maxEntries?: number;
    readonly now?: () => number;
};

export type TuiFrecencyScore = {
    readonly record: TuiFrecencyRecord;
    readonly score: number;
};

export class TuiFrecencyStore {
    readonly filePath: string;
    private readonly maxEntries: number;
    private readonly now: () => number;

    constructor(options: TuiFrecencyStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'tui', 'frecency.jsonl');
        this.maxEntries = options.maxEntries ?? TUI_FRECENCY_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }

    async listRecords(): Promise<readonly TuiFrecencyRecord[]> {
        const contents = await readOptionalTextFile(this.filePath);
        if (contents === undefined) {
            return [];
        }
        return retainLatestByKey(parseJsonlRecords(contents, TuiFrecencyRecordSchema)).slice(0, this.maxEntries);
    }

    async listByScore(now = this.now()): Promise<readonly TuiFrecencyScore[]> {
        return (await this.listRecords())
            .map((record) => ({ record, score: frecencyScore(record, now) }))
            .sort((left, right) => right.score - left.score);
    }

    async recordAccess(key: string): Promise<TuiFrecencyRecord> {
        const now = this.now();
        const records = await this.listRecords();
        const existing = records.find((record) => record.key === key);
        const next = TuiFrecencyRecordSchema.parse({
            key,
            accessCount: (existing?.accessCount ?? 0) + 1,
            firstSeenAt: existing?.firstSeenAt ?? now,
            lastAccessedAt: now,
        });
        await this.writeRecords(
            [...records.filter((record) => record.key !== key), next]
                .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
                .slice(0, this.maxEntries),
        );
        return next;
    }

    async replaceRecords(records: readonly TuiFrecencyRecord[]): Promise<void> {
        await this.writeRecords(retainLatestByKey(records).slice(0, this.maxEntries));
    }

    private async writeRecords(records: readonly TuiFrecencyRecord[]): Promise<void> {
        await atomicWriteTextFile(
            this.filePath,
            jsonlText(records.map((record) => TuiFrecencyRecordSchema.parse(record))),
        );
    }
}

export function frecencyScore(record: TuiFrecencyRecord, now: number): number {
    return record.accessCount / Math.max(1, now - record.lastAccessedAt);
}

function retainLatestByKey(records: readonly TuiFrecencyRecord[]): readonly TuiFrecencyRecord[] {
    const retained = new Map<string, TuiFrecencyRecord>();
    for (const record of records) {
        const existing = retained.get(record.key);
        if (existing === undefined || record.lastAccessedAt >= existing.lastAccessedAt) {
            retained.set(record.key, record);
        }
    }
    return [...retained.values()].sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
}
