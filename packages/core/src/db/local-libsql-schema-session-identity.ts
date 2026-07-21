import type { Client } from '@libsql/client';
import { z } from 'zod';

const tableColumnSchema = z.object({ name: z.string() });

const SESSION_IDENTITY_COLUMNS = ['category', 'agent_name'] as const;

export async function ensureSessionIdentityColumns(client: Client): Promise<void> {
    const result = await client.execute("PRAGMA table_info('sessions')");
    const existing = new Set(result.rows.map((row) => tableColumnSchema.parse(row).name));
    for (const column of SESSION_IDENTITY_COLUMNS) {
        if (existing.has(column)) continue;
        await client.execute(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
}
