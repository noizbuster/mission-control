import type { Client, InStatement } from '@libsql/client';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { drizzle } from 'drizzle-orm/libsql';
import { z } from 'zod';
import { type LocalLibsqlWriteKey, resolveLocalLibsqlIdentity } from './local-libsql-identity.js';
import { ensureLocalDbSchema } from './local-libsql-schema.js';
import { createHash } from 'node:crypto';

export type { LocalDbConfigErrorCode, LocalLibsqlWriteKey } from './local-libsql-identity.js';
export { LocalDbConfigError, localDbConfigErrorCodes } from './local-libsql-identity.js';

export const localDbMigrationErrorCodes = [
    'invalid_migration_id',
    'empty_migration_sql',
    'duplicate_migration_id',
    'migration_checksum_mismatch',
] as const;
export type LocalDbMigrationErrorCode = (typeof localDbMigrationErrorCodes)[number];

export class LocalDbMigrationError extends Error {
    readonly code: LocalDbMigrationErrorCode;
    readonly migrationId: string;

    constructor(code: LocalDbMigrationErrorCode, migrationId: string, message: string) {
        super(message);
        this.name = 'LocalDbMigrationError';
        this.code = code;
        this.migrationId = migrationId;
    }
}

export type LocalDbMigration = {
    readonly id: string;
    readonly sql: string | readonly string[];
};

export type LocalDbMigrationLedgerRow = {
    readonly id: string;
    readonly checksum: string;
    readonly appliedAt: string;
};

export type LocalLibsqlDb = {
    readonly url: string;
    readonly writeKey: LocalLibsqlWriteKey;
    readonly client: Client;
    readonly db: LibSQLDatabase<Record<string, never>>;
    readonly close: () => void;
};

export type LocalLibsqlWriteTarget = Pick<LocalLibsqlDb, 'writeKey' | 'client'>;

export type OpenLocalLibsqlDbOptions = {
    readonly url: string;
    readonly cwd?: string;
    readonly migrations?: readonly LocalDbMigration[];
};

const migrationIdPattern = /^\d{4}_[a-z0-9_]+$/u;
const localDbWriteQueues = new Map<LocalLibsqlWriteKey, Promise<void>>();

const migrationLedgerRowSchema = z.object({
    id: z.string(),
    checksum: z.string(),
    applied_at: z.string(),
});

const existingMigrationRowSchema = z.object({
    checksum: z.string(),
});

const createSchemaMigrationsSql = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
        id         TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TEXT NOT NULL
    );
`;

export async function openLocalLibsqlDb(options: OpenLocalLibsqlDbOptions): Promise<LocalLibsqlDb> {
    const identity = await resolveLocalLibsqlIdentity(options);
    const client = createClient({ url: identity.url });
    try {
        await runWithLocalLibsqlWriteLock(identity.writeKey, () =>
            options.migrations === undefined
                ? ensureLocalDbSchema(client)
                : runLocalDbMigrations(client, options.migrations),
        );
    } catch (error: unknown) {
        client.close();
        throw error;
    }

    return {
        url: identity.url,
        writeKey: identity.writeKey,
        client,
        db: drizzle(client),
        close: () => client.close(),
    };
}

export async function runWithLocalLibsqlWriteLock<T>(
    writeKey: LocalLibsqlWriteKey,
    write: () => Promise<T>,
): Promise<T> {
    const previous = localDbWriteQueues.get(writeKey) ?? Promise.resolve();
    let releaseQueue = (): void => {};
    const current = new Promise<void>((resolve) => {
        releaseQueue = resolve;
    });
    const queued = previous.then(() => current);
    localDbWriteQueues.set(writeKey, queued);
    await previous;

    try {
        return await write();
    } finally {
        releaseQueue();
        if (localDbWriteQueues.get(writeKey) === queued) {
            localDbWriteQueues.delete(writeKey);
        }
    }
}

export async function runLocalLibsqlWrite<T>(
    target: LocalLibsqlWriteTarget,
    write: (client: Client) => Promise<T>,
): Promise<T> {
    return runWithLocalLibsqlWriteLock(target.writeKey, () => write(target.client));
}

export async function runLocalDbMigrations(client: Client, migrations: readonly LocalDbMigration[]): Promise<void> {
    const planned = normalizeMigrations(migrations);
    await client.execute(createSchemaMigrationsSql);

    for (const migration of planned) {
        const existing = await client.execute({
            sql: 'SELECT checksum FROM schema_migrations WHERE id = ?',
            args: [migration.id],
        });
        const row = existing.rows[0];
        if (row !== undefined) {
            const parsed = existingMigrationRowSchema.parse(row);
            if (parsed.checksum !== migration.checksum) {
                throw new LocalDbMigrationError(
                    'migration_checksum_mismatch',
                    migration.id,
                    `Migration ${migration.id} was already applied with a different checksum`,
                );
            }
            continue;
        }

        const batchStatements: InStatement[] = [
            ...migration.statements,
            {
                sql: 'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
                args: [migration.id, migration.checksum, new Date().toISOString()],
            },
        ];
        await client.batch(batchStatements, 'write');
    }
}

export async function listLocalDbMigrationLedger(client: Client): Promise<readonly LocalDbMigrationLedgerRow[]> {
    await client.execute(createSchemaMigrationsSql);
    const result = await client.execute('SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id');

    return result.rows.map((row) => {
        const parsed = migrationLedgerRowSchema.parse(row);
        return {
            id: parsed.id,
            checksum: parsed.checksum,
            appliedAt: parsed.applied_at,
        };
    });
}

type PlannedMigration = {
    readonly id: string;
    readonly statements: readonly string[];
    readonly checksum: string;
};

function normalizeMigrations(migrations: readonly LocalDbMigration[]): readonly PlannedMigration[] {
    const seenIds = new Set<string>();

    return migrations.map((migration) => {
        if (!migrationIdPattern.test(migration.id)) {
            throw new LocalDbMigrationError(
                'invalid_migration_id',
                migration.id,
                `Migration id must match ${migrationIdPattern.source}: ${migration.id}`,
            );
        }
        if (seenIds.has(migration.id)) {
            throw new LocalDbMigrationError(
                'duplicate_migration_id',
                migration.id,
                `Migration id appears more than once: ${migration.id}`,
            );
        }
        seenIds.add(migration.id);

        const statements = normalizeMigrationSql(migration);
        return {
            id: migration.id,
            statements,
            checksum: checksumFor(statements),
        };
    });
}

function normalizeMigrationSql(migration: LocalDbMigration): readonly string[] {
    const statements = typeof migration.sql === 'string' ? [migration.sql] : migration.sql;
    const cleaned = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);

    if (cleaned.length === 0) {
        throw new LocalDbMigrationError(
            'empty_migration_sql',
            migration.id,
            `Migration ${migration.id} must contain at least one SQL statement`,
        );
    }

    return cleaned;
}

function checksumFor(statements: readonly string[]): string {
    return createHash('sha256').update(statements.join('\n')).digest('hex');
}
