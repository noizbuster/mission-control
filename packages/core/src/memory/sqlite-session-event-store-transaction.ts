import type { LocalLibsqlDb } from '../db/local-libsql-db';
import { runWithLocalLibsqlWriteLock } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';

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
