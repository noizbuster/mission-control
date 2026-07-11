import type { Client } from '@libsql/client';

export async function runLocalLibsqlClientTransaction<T>(client: Client, write: () => Promise<T>): Promise<T> {
    await client.execute('BEGIN IMMEDIATE TRANSACTION');
    try {
        const result = await write();
        await client.execute('COMMIT');
        return result;
    } catch (error: unknown) {
        try {
            await client.execute('ROLLBACK');
        } catch (rollbackError: unknown) {
            throw new AggregateError([error, rollbackError], 'database write and rollback both failed');
        }
        throw error;
    }
}
