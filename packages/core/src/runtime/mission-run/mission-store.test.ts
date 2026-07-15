import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../../providers/observability-redactor';
import { materializeMission } from './mission-run-service';
import { makeMissionRunTestLocation, makeTestWorkflowSpec } from './mission-run-test-support';
import {
    createMission,
    listMissions,
    type MissionPatch,
    MissionStoreError,
    missionFilePath,
    readMission,
    updateMission,
} from './mission-store';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('mission-store', () => {
    it('roundtrips a Mission through create and read', async () => {
        const location = makeMissionRunTestLocation();
        const mission = materializeMission(makeTestWorkflowSpec());

        await createMission(location, mission);
        const read = await readMission(location, mission.id);

        expect(read).toEqual(mission);
    });

    it('throws MissionStoreError(mission_missing) for unknown id', async () => {
        const location = makeMissionRunTestLocation();
        await expect(readMission(location, 'nonexistent')).rejects.toMatchObject({
            code: 'mission_missing',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for invalid JSON', async () => {
        const location = makeMissionRunTestLocation();
        const filePath = missionFilePath(location.omoRoot, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ not valid json');

        await expect(readMission(location, 'bad')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for schema-invalid content', async () => {
        const location = makeMissionRunTestLocation();
        const filePath = missionFilePath(location.omoRoot, 'bad-schema');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ id: 'bad-schema', name: 'missing fields' }));

        await expect(readMission(location, 'bad-schema')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('rejects traversal in compatible Mission ids', async () => {
        const location = makeMissionRunTestLocation();

        await expect(readMission(location, '../outside')).rejects.toMatchObject({ code: 'invalid_mission_id' });
    });

    it.skipIf(process.platform === 'win32')('rejects a symlinked compatible Missions directory', async () => {
        const location = makeMissionRunTestLocation();
        const externalMissions = join(location.omoRoot, 'external-missions');
        const mission = materializeMission(makeTestWorkflowSpec());
        mkdirSync(externalMissions, { recursive: true });
        writeFileSync(join(externalMissions, `${mission.id}.json`), JSON.stringify(mission));
        symlinkSync(externalMissions, join(location.omoRoot, '.omo', 'missions'));

        await expect(readMission(location, mission.id)).rejects.toMatchObject({ code: 'mission_unsafe_source' });
    });

    it('rejects a compatible Mission whose payload id differs from its filename', async () => {
        const location = makeMissionRunTestLocation();
        const mission = materializeMission(makeTestWorkflowSpec());
        const filePath = missionFilePath(location.omoRoot, 'requested-mission');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify(mission));

        await expect(readMission(location, 'requested-mission')).rejects.toMatchObject({ code: 'mission_corrupt' });
    });

    it('redacts configured credentials while importing an on-demand compatible Mission', async () => {
        const baseLocation = makeMissionRunTestLocation();
        const credential = ['compatible', 'mission', 'credential'].join('_');
        const location = {
            ...baseLocation,
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        };
        const mission = materializeMission({
            ...makeTestWorkflowSpec(),
            description: `mission ${credential}`,
        });
        const filePath = missionFilePath(location.omoRoot, mission.id);
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify(mission));

        const imported = await readMission(location, mission.id);

        expect(imported.description).toContain('[REDACTED_CREDENTIAL]');
        expect(imported.description).not.toContain(credential);
    });

    it('updates a Mission with a patch and refreshes updatedAt', async () => {
        const location = makeMissionRunTestLocation();
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(location, mission);
        const patch: MissionPatch = { description: 'updated description', status: 'active' };

        const before = new Date(mission.updatedAt).getTime();
        const updated = await updateMission(location, mission.id, patch, {
            now: () => new Date(before + 5000).toISOString(),
        });

        expect(updated.description).toBe('updated description');
        expect(updated.status).toBe('active');
        expect(new Date(updated.updatedAt).getTime()).toBe(before + 5000);
    });

    it('lists all persisted Missions', async () => {
        const location = makeMissionRunTestLocation();
        const m1 = materializeMission(makeTestWorkflowSpec());
        const m2 = materializeMission(makeTestWorkflowSpec());
        await createMission(location, m1);
        await createMission(location, m2);

        const missions = await listMissions(location);

        expect(missions).toHaveLength(2);
        const ids = missions.map((m) => m.id);
        expect(ids).toContain(m1.id);
        expect(ids).toContain(m2.id);
    });

    it('listMissions returns empty array when directory does not exist', async () => {
        const location = makeMissionRunTestLocation();
        const missions = await listMissions(location);
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
