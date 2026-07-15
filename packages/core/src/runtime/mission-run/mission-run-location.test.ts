import { describe, expect, it, vi } from 'vitest';
import { openLocalLibsqlDb } from '../../db/local-libsql-db.js';
import { localSessionDbPath } from '../../memory/local-session-store-paths.js';
import { materializeMission } from './mission-run-service.js';
import { normalizeMissionRunStoreLocation } from './mission-run-store-location.js';
import { makeTempRoot, makeTestWorkflowSpec, seedOmoRoot } from './mission-run-test-support.js';
import { createMission, listMissions } from './mission-store.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const retiredDatabaseFilename = ['memory', 'db'].join('.');

describe('Mission/Run SQL location', () => {
    it('treats a string as the project root and resolves only the SQL data dir', () => {
        const tempRoot = makeTempRoot();
        const dataDir = join(tempRoot, 'environment-data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const location = normalizeMissionRunStoreLocation(join(tempRoot, 'project'));

        expect(location).toEqual({ omoRoot: join(tempRoot, 'project'), dataDir });
    });

    it('writes only to an explicit data dir when the project root is separate', async () => {
        const tempRoot = makeTempRoot();
        const omoRoot = join(tempRoot, 'workspace');
        const dataDir = join(tempRoot, 'product-data');
        const defaultDataDir = join(tempRoot, 'environment-data');
        mkdirSync(omoRoot, { recursive: true });
        seedOmoRoot(omoRoot);
        vi.stubEnv('MCTRL_DATA_DIR', defaultDataDir);

        await createMission({ omoRoot, dataDir }, materializeMission(makeTestWorkflowSpec()));

        expect(existsSync(localSessionDbPath(dataDir))).toBe(true);
        expect(existsSync(localSessionDbPath(defaultDataDir))).toBe(false);
        expect(existsSync(join(omoRoot, retiredDatabaseFilename))).toBe(false);
        expect(existsSync(join(omoRoot, '.omo', retiredDatabaseFilename))).toBe(false);
        expect(existsSync(localSessionDbPath(omoRoot))).toBe(false);
    });

    it('does not probe a pre-existing workspace SQL file', async () => {
        const tempRoot = makeTempRoot();
        const omoRoot = join(tempRoot, 'workspace');
        const dataDir = join(tempRoot, 'product-data');
        mkdirSync(omoRoot, { recursive: true });
        seedOmoRoot(omoRoot);
        const retiredDatabasePath = join(omoRoot, retiredDatabaseFilename);
        const retiredMission = materializeMission(makeTestWorkflowSpec());
        const retiredDb = await openLocalLibsqlDb({ url: pathToFileURL(retiredDatabasePath).href });
        await retiredDb.client.execute({
            sql:
                'INSERT INTO missions (mission_id, status, workflow_name, created_at, updated_at, payload_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?)',
            args: [
                retiredMission.id,
                retiredMission.status,
                retiredMission.workflowName ?? null,
                retiredMission.createdAt,
                retiredMission.updatedAt,
                JSON.stringify(retiredMission),
            ],
        });
        await retiredDb.client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
        retiredDb.close();
        const retiredDatabaseBytes = readFileSync(retiredDatabasePath);

        expect(await listMissions({ omoRoot, dataDir })).toEqual([]);
        expect(existsSync(localSessionDbPath(dataDir))).toBe(true);
        expect(readFileSync(retiredDatabasePath)).toEqual(retiredDatabaseBytes);
    });
});
