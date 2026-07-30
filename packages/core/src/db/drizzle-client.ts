import type { Client } from '@libsql/client';
import { type LibSQLDatabase, drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

export type MissionControlDrizzleDb = LibSQLDatabase<typeof schema>;

/** Build a typed Drizzle handle over an already-open local libSQL client. */
export function drizzleFromClient(client: Client): MissionControlDrizzleDb {
    return drizzle(client, { schema });
}
