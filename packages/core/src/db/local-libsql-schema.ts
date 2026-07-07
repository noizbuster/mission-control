import type { Client, InStatement } from '@libsql/client';
import { agentJobRelationSchemaSql } from './local-libsql-schema-agent-jobs.js';
import { sessionEventStoreSchemaSql } from './local-libsql-schema-events.js';
import { memoryEntriesSchemaSql } from './local-libsql-schema-memory.js';
import { sessionProjectionSchemaSql } from './local-libsql-schema-projections.js';
import { runtimePersistenceSchemaSql } from './local-libsql-schema-runtime.js';

export const localDbSchemaSql = [
    ...memoryEntriesSchemaSql,
    ...runtimePersistenceSchemaSql,
    ...sessionEventStoreSchemaSql,
    ...sessionProjectionSchemaSql,
    ...agentJobRelationSchemaSql,
] as const;

export async function ensureLocalDbSchema(client: Client): Promise<void> {
    const statements: InStatement[] = localDbSchemaSql.map((sql) => ({ sql }));
    await client.batch(statements, 'write');
}
