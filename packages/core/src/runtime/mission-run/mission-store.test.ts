import { describe, expect, it } from 'vitest';
import { materializeMission } from './mission-run-service.js';
import { makeTempRoot, makeTestWorkflowSpec, seedOmoRoot } from './mission-run-test-support.js';
import {
    createMission,
    listMissions,
    type MissionPatch,
    MissionStoreError,
    missionFilePath,
    readMission,
    updateMission,
} from './mission-store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('mission-store', () => {
    it('roundtrips a Mission through create and read', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());

        await createMission(root, mission);
        const read = await readMission(root, mission.id);

        expect(read).toEqual(mission);
    });

    it('throws MissionStoreError(mission_missing) for unknown id', async () => {
        const root = seedOmoRoot(makeTempRoot());
        await expect(readMission(root, 'nonexistent')).rejects.toMatchObject({
            code: 'mission_missing',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for invalid JSON', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = missionFilePath(root, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ not valid json');

        await expect(readMission(root, 'bad')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for schema-invalid content', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = missionFilePath(root, 'bad-schema');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ id: 'bad-schema', name: 'missing fields' }));

        await expect(readMission(root, 'bad-schema')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('updates a Mission with a patch and refreshes updatedAt', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const patch: MissionPatch = { description: 'updated description', status: 'active' };

        const before = new Date(mission.updatedAt).getTime();
        const updated = await updateMission(root, mission.id, patch, {
            now: () => new Date(before + 5000).toISOString(),
        });

        expect(updated.description).toBe('updated description');
        expect(updated.status).toBe('active');
        expect(new Date(updated.updatedAt).getTime()).toBe(before + 5000);
    });

    it('lists all persisted Missions', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const m1 = materializeMission(makeTestWorkflowSpec());
        const m2 = materializeMission(makeTestWorkflowSpec());
        await createMission(root, m1);
        await createMission(root, m2);

        const missions = await listMissions(root);

        expect(missions).toHaveLength(2);
        const ids = missions.map((m) => m.id);
        expect(ids).toContain(m1.id);
        expect(ids).toContain(m2.id);
    });

    it('listMissions returns empty array when directory does not exist', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const missions = await listMissions(root);
        expect(missions).toEqual([]);
    });
});

describe('MissionStoreError', () => {
    it('extends OmoPersistenceError', () => {
        const err = new MissionStoreError('test', 'test_code');
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('test_code');
    });
});
