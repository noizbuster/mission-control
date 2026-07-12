import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction.js';

export async function runSqliteSessionWriteTransaction<T>(input: {
    readonly runtime: LocalLibsqlDb;
    readonly ensureOpen: () => void;
    readonly write: () => Promise<T>;
}): Promise<T> {
    return runWithLocalLibsqlWriteLock(input.runtime, async () => {
        input.ensureOpen();
        return runLocalLibsqlClientTransaction(input.runtime.client, input.write);
    });
}
