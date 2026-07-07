export const memoryEntriesSchemaSql = [
    `
        CREATE TABLE IF NOT EXISTS memory_entries (
            namespace  TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            PRIMARY KEY (namespace, key)
        );
    `,
] as const;
