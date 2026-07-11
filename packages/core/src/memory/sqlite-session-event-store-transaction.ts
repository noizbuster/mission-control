import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';

export async function runSqliteSessionWriteTransaction<T>(input: {
    readonly runtime: LocalLibsqlDb;
    readonly ensureOpen: () => void;
    readonly write: () => Promise<T>;
}): Promise<T> {
    return runWithLocalLibsqlWriteLock(input.runtime, async () => {
        input.ensureOpen();
        await input.runtime.client.execute('BEGIN IMMEDIATE TRANSACTION');
        try {
            const result = await input.write();
            await input.runtime.client.execute('COMMIT');
            return result;
        } catch (error) {
            await input.runtime.client.execute('ROLLBACK');
            throw error;
        }
    });
}
