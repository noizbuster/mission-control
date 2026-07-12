import type { Client } from '@libsql/client';
import { quarantineLocalLibsqlClient } from './local-libsql-registry.js';

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
            const aggregate = new AggregateError([error, rollbackError], 'database write and rollback both failed');
            quarantineLocalLibsqlClient(client);
            throw aggregate;
        }
        throw error;
    }
}
