import type { Client, ResultSet, Row, Value } from '@libsql/client';
import {
    type RuntimeDbMigrationTableDescriptor,
    runtimeDbMigrationTableDescriptors,
} from './runtime-db-migration-descriptors.js';
import { RuntimeDbMigrationError } from './runtime-db-migration-error.js';
import type { LegacyRunSource } from './runtime-db-migration-sources.js';
import { createHash } from 'node:crypto';

export type RuntimeDbMigrationTableManifest = RuntimeDbMigrationTableDescriptor & {
    readonly present: boolean;
    readonly rowCount: number;
    readonly contentSha256: string;
};

export type LoadedRuntimeDbTable = {
    readonly descriptor: RuntimeDbMigrationTableDescriptor;
    readonly manifest: RuntimeDbMigrationTableManifest;
    readonly rows: readonly Readonly<Record<string, Value>>[];
};

export function emptyLegacyRuntimeTables(): readonly LoadedRuntimeDbTable[] {
    return runtimeDbMigrationTableDescriptors.map((descriptor) => ({
        descriptor,
        rows: [],
        manifest: { ...descriptor, present: false, rowCount: 0, contentSha256: sha256('[]') },
    }));
}

export async function loadLegacyRuntimeTables(input: {
    readonly client: Client;
    readonly alias: string;
    readonly sourcePath: string;
}): Promise<readonly LoadedRuntimeDbTable[]> {
    const tables: LoadedRuntimeDbTable[] = [];
    for (const descriptor of runtimeDbMigrationTableDescriptors) {
        const present = await attachedTableExists(input.client, input.alias, descriptor.table);
        if (!present) {
            tables.push({
                descriptor,
                rows: [],
                manifest: { ...descriptor, present: false, rowCount: 0, contentSha256: sha256('[]') },
            });
            continue;
        }
        let result: ResultSet;
        try {
            result = await input.client.execute(
                `SELECT ${descriptor.columns.join(', ')} FROM ${input.alias}.${descriptor.table} ` +
                    `ORDER BY ${descriptor.keyColumns.join(', ')}`,
            );
        } catch (error: unknown) {
            throw new RuntimeDbMigrationError({
                code: 'source_db_corrupt',
                path: input.sourcePath,
                table: descriptor.table,
                message: `Legacy runtime table ${descriptor.table} does not match the required schema`,
                cause: error,
            });
        }
        const rows = result.rows.map((row) => selectColumns(row, descriptor.columns));
        tables.push({
            descriptor,
            rows,
            manifest: {
                ...descriptor,
                present: true,
                rowCount: rows.length,
                contentSha256: sha256(serializeRows(descriptor, rows)),
            },
        });
    }
    return tables;
}

export async function copyLegacyRuntimeRows(input: {
    readonly client: Client;
    readonly tables: readonly LoadedRuntimeDbTable[];
    readonly runs: readonly LegacyRunSource[];
}): Promise<readonly string[]> {
    const projectionSessionIds = new Set(projectionSessionIdsForTables(input.tables));
    for (const table of input.tables) {
        for (const row of table.rows) {
            await copyRow(input.client, table.descriptor, row);
            if (table.descriptor.table === 'session_events') {
                const sessionId = rowValue(row, 'session_id');
                if (typeof sessionId === 'string') projectionSessionIds.add(sessionId);
            }
        }
        if (table.descriptor.table === 'mission_runs') {
            for (const run of input.runs) {
                await copyRow(input.client, table.descriptor, run.row);
            }
        }
    }
    return [...projectionSessionIds].sort(compareUtf8);
}

export function projectionSessionIdsForTables(tables: readonly LoadedRuntimeDbTable[]): readonly string[] {
    const sessionIds = new Set<string>();
    const eventTable = tables.find((table) => table.descriptor.table === 'session_events');
    for (const row of eventTable?.rows ?? []) {
        const sessionId = rowValue(row, 'session_id');
        if (typeof sessionId === 'string') sessionIds.add(sessionId);
    }
    return [...sessionIds].sort(compareUtf8);
}

async function copyRow(
    client: Client,
    descriptor: RuntimeDbMigrationTableDescriptor,
    row: Readonly<Record<string, Value>>,
): Promise<void> {
    const byKey = await matchingRow(client, descriptor, row, descriptor.keyColumns);
    if (byKey !== undefined) {
        if (rowsEqual(descriptor.columns, row, byKey)) return;
        throw collision(descriptor, 'primary key');
    }
    for (const uniqueColumns of descriptor.uniqueConstraints) {
        if (uniqueColumns.some((column) => row[column] === null)) continue;
        if ((await matchingRow(client, descriptor, row, uniqueColumns)) !== undefined) {
            throw collision(descriptor, `unique constraint (${uniqueColumns.join(', ')})`);
        }
    }
    await client.execute({
        sql: `INSERT INTO ${descriptor.table} (${descriptor.columns.join(', ')}) VALUES (${descriptor.columns
            .map(() => '?')
            .join(', ')})`,
        args: descriptor.columns.map((column) => row[column] ?? null),
    });
}

async function matchingRow(
    client: Client,
    descriptor: RuntimeDbMigrationTableDescriptor,
    row: Readonly<Record<string, Value>>,
    matchColumns: readonly string[],
): Promise<Readonly<Record<string, Value>> | undefined> {
    const result = await client.execute({
        sql:
            `SELECT ${descriptor.columns.join(', ')} FROM ${descriptor.table} WHERE ` +
            matchColumns.map((column) => `${column} IS ?`).join(' AND ') +
            ' LIMIT 1',
        args: matchColumns.map((column) => row[column] ?? null),
    });
    const match = result.rows[0];
    return match === undefined ? undefined : selectColumns(match, descriptor.columns);
}

async function attachedTableExists(client: Client, alias: string, table: string): Promise<boolean> {
    const result = await client.execute({
        sql: `SELECT 1 FROM ${alias}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        args: [table],
    });
    return result.rows.length > 0;
}

function selectColumns(row: Row, columns: readonly string[]): Readonly<Record<string, Value>> {
    const selected: Record<string, Value> = {};
    for (const column of columns) selected[column] = row[column] ?? null;
    return selected;
}

function rowsEqual(
    columns: readonly string[],
    left: Readonly<Record<string, Value>>,
    right: Readonly<Record<string, Value>>,
): boolean {
    return columns.every((column) => valuesEqual(left[column] ?? null, right[column] ?? null));
}

function rowValue(row: Readonly<Record<string, Value>>, column: string): Value {
    return row[column] ?? null;
}

function valuesEqual(left: Value, right: Value): boolean {
    if (left instanceof ArrayBuffer && right instanceof ArrayBuffer) {
        return Buffer.from(left).equals(Buffer.from(right));
    }
    if (typeof left === 'number' && typeof right === 'bigint') {
        return Number.isSafeInteger(left) && BigInt(left) === right;
    }
    if (typeof left === 'bigint' && typeof right === 'number') {
        return Number.isSafeInteger(right) && left === BigInt(right);
    }
    return left === right;
}

function serializeRows(
    descriptor: RuntimeDbMigrationTableDescriptor,
    rows: readonly Readonly<Record<string, Value>>[],
): string {
    return JSON.stringify(rows.map((row) => descriptor.columns.map((column) => serializeValue(row[column] ?? null))));
}

function serializeValue(value: Value): readonly [string, string] {
    if (value === null) return ['null', ''];
    if (typeof value === 'string') return ['text', value];
    if (typeof value === 'number') return ['number', String(value)];
    if (typeof value === 'bigint') return ['integer', value.toString()];
    return ['blob', Buffer.from(value).toString('base64')];
}

function collision(descriptor: RuntimeDbMigrationTableDescriptor, kind: string): RuntimeDbMigrationError {
    return new RuntimeDbMigrationError({
        code: 'row_collision',
        table: descriptor.table,
        message: `Legacy runtime table ${descriptor.table} has a differing ${kind} collision`,
    });
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareUtf8(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
