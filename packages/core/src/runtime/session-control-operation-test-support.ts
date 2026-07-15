import type { LocalLibsqlDb } from '../db/local-libsql-db';
import { openCanonicalRuntimeDb } from './local-runtime-db';
import { acquireSessionControlLease, type SessionControlLease } from './session-control-lease';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_DB_IDENTITY = 'd'.repeat(64);
export const TEST_SESSION_ID = 'session-operation';

const tempDirectories: string[] = [];

export async function createOperationTestRuntime(): Promise<LocalLibsqlDb> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-control-operation-'));
    tempDirectories.push(directory);
    const { runtime } = await openCanonicalRuntimeDb({ dataDir: directory });
    return runtime;
}

export async function cleanupOperationTestRuntimes(): Promise<void> {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function acquireOperationTestLease(
    runtime: LocalLibsqlDb,
    ownerId: string,
    nowWallMs: number,
): Promise<SessionControlLease> {
    const acquired = await acquireSessionControlLease({
        runtime,
        dbIdentity: TEST_DB_IDENTITY,
        sessionId: TEST_SESSION_ID,
        ownerId,
        nonceHash: createHash('sha256').update(ownerId).digest('hex'),
        pid: process.pid,
        processStartId: `start-${ownerId}`,
        nowWallMs,
    });
    return acquired.lease;
}

export async function createMutationProbe(runtime: LocalLibsqlDb): Promise<void> {
    await runtime.client.execute('CREATE TABLE mutation_probe (value TEXT PRIMARY KEY)');
}

export async function readMutationProbe(runtime: LocalLibsqlDb): Promise<readonly unknown[]> {
    const rows = await runtime.client.execute('SELECT value FROM mutation_probe ORDER BY value');
    return rows.rows;
}
