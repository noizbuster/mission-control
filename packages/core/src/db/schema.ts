/**
 * Drizzle schema for the persistent working-memory store (ABG §10.4/§12).
 *
 * Mirrors the on-disk shape from `memory/sqlite-persistent-store.ts` exactly so the
 * Turso/libSQL adapter is a behaviorally identical drop-in for the dead better-sqlite3
 * adapter. The table is created via `CREATE TABLE IF NOT EXISTS` (raw SQL in the store)
 * — drizzle-kit schema generation is intentionally NOT used here.
 */
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export * from './session-agent-schema.js';
export * from './session-core-schema.js';
export * from './session-projection-schema.js';
export * from './session-schema-literals.js';

export const memoryEntries = sqliteTable(
    'memory_entries',
    {
        namespace: text('namespace').notNull(),
        key: text('key').notNull(),
        // JSON-serialized value (see serializeValue in sqlite-persistent-store.ts).
        value: text('value').notNull(),
        createdAt: text('created_at').notNull(),
        // ISO timestamp; null means "never expires".
        expiresAt: text('expires_at'),
    },
    (table) => [primaryKey({ columns: [table.namespace, table.key] })],
);
