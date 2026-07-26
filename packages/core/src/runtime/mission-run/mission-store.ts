/**
 * Mission store — SQL-backed CRUD for Mission state objects.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/mission-control.db`.
 * Missing SQL rows may fall back to `.mc/missions/{missionId}.json` compatibility
 * records owned by this store. Database startup never probes an older SQL file.
 */

import { type Mission, type MissionCapabilities, MissionSchema, type MissionStatus } from '@mission-control/protocol';
import { compatibilityJsonFilePath, listCompatibilityJsonRecordIds } from '../../persistence/json-compatibility-file';
import { McPersistenceError } from '../../persistence/paths';
import type { ObservabilityRedactor } from '../../providers/observability-redactor';
import { mapJsonCompatibilityFileError, readCompatibilityRecord } from './compat-record-reader';
import { listMissionsFromDb, readMissionFromDb, writeMissionToDb } from './mission-run-db';
import { type MissionRunStoreLocation, normalizeMissionRunStoreLocation } from './mission-run-store-location';

const MISSIONS_DIR = 'missions';

export class MissionStoreError extends McPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause);
        this.name = 'MissionStoreError';
    }
}

/**
 * Patchable Mission fields. `id`, `graph`, `graphId`, and `createdAt` are
 * immutable after creation and intentionally absent.
 */
export type MissionPatch = {
    readonly name?: string;
    readonly description?: string;
    readonly status?: MissionStatus;
    readonly version?: string;
    readonly model?: Mission['model'];
    readonly capabilities?: MissionCapabilities;
    readonly policies?: Mission['policies'];
    readonly budget?: Mission['budget'];
    readonly workflowName?: string;
    readonly modeDeclarations?: Mission['modeDeclarations'];
};

export function missionFilePath(root: string, missionId: string): string {
    try {
        return compatibilityJsonFilePath(root, MISSIONS_DIR, missionId);
    } catch (error: unknown) {
        throw mapCompatibilityError(error, missionId);
    }
}

/**
 * Validate and persist a Mission atomically. The input is parsed through
 * `MissionSchema` before writing so malformed state is rejected at the boundary.
 */
export async function createMission(location: MissionRunStoreLocation, mission: Mission): Promise<Mission> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const validated = sanitizeMissionForPersistence(mission, normalized.observabilityRedactor);
    await writeMissionToDb(normalized.dataDir, validated);
    return validated;
}

/**
 * Read and validate a Mission by id. Throws `MissionStoreError`
 * ({ code: 'mission_missing' }) on ENOENT, ({ code: 'mission_corrupt' }) on
 * JSON/schema validation failure.
 */
export async function readMission(location: MissionRunStoreLocation, missionId: string): Promise<Mission> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const dbMission = await readMissionFromDb(normalized.dataDir, missionId);
    if (dbMission !== undefined) {
        return sanitizeMissionForPersistence(dbMission, normalized.observabilityRedactor);
    }
    const legacyMission = sanitizeMissionForPersistence(
        await readMissionJson(normalized.mcRoot, missionId),
        normalized.observabilityRedactor,
    );
    await writeMissionToDb(normalized.dataDir, legacyMission);
    return legacyMission;
}

async function readMissionJson(root: string, missionId: string): Promise<Mission> {
    return readCompatibilityRecord<Mission>({
        root,
        dir: MISSIONS_DIR,
        id: missionId,
        filePath: missionFilePath(root, missionId),
        schema: MissionSchema,
        toError: (message, code, path, cause) => new MissionStoreError(message, code, path, cause),
        corruptCode: 'mission_corrupt',
        entityNoun: 'Mission',
        mapReadError: (error) => mapCompatibilityError(error, missionId),
    });
}

/**
 * Read-modify-write a Mission. The patch is shallow-merged over the stored
 * Mission; `updatedAt` is refreshed to `now()`.
 */
export async function updateMission(
    location: MissionRunStoreLocation,
    missionId: string,
    patch: MissionPatch,
    options: { readonly now?: () => string } = {},
): Promise<Mission> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const now = options.now?.() ?? new Date().toISOString();
    const existing = await readMission(normalized, missionId);
    const updated: Mission = { ...existing, ...patch, updatedAt: now };
    const validated = sanitizeMissionForPersistence(updated, normalized.observabilityRedactor);
    await writeMissionToDb(normalized.dataDir, validated);
    return validated;
}

/**
 * List all persisted Missions. Returns an empty array when the missions
 * directory does not exist yet. Throws on corrupt individual files.
 */
export async function listMissions(location: MissionRunStoreLocation): Promise<readonly Mission[]> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const missions = (await listMissionsFromDb(normalized.dataDir)).map((mission) =>
        sanitizeMissionForPersistence(mission, normalized.observabilityRedactor),
    );
    const seenIds = new Set(missions.map((mission) => mission.id));
    let missionIds: readonly string[];
    try {
        missionIds = await listCompatibilityJsonRecordIds(normalized.mcRoot, MISSIONS_DIR);
    } catch (error: unknown) {
        throw mapCompatibilityError(error, MISSIONS_DIR);
    }

    for (const missionId of missionIds) {
        if (seenIds.has(missionId)) {
            continue;
        }
        const mission = sanitizeMissionForPersistence(
            await readMissionJson(normalized.mcRoot, missionId),
            normalized.observabilityRedactor,
        );
        await writeMissionToDb(normalized.dataDir, mission);
        missions.push(mission);
        seenIds.add(mission.id);
    }
    return missions;
}

function sanitizeMissionForPersistence(mission: Mission, observabilityRedactor?: ObservabilityRedactor): Mission {
    return MissionSchema.parse(observabilityRedactor?.redactValue(mission) ?? mission);
}

function mapCompatibilityError(error: unknown, missionId: string): MissionStoreError {
    return mapJsonCompatibilityFileError<MissionStoreError>(error, missionId, {
        toError: (message, code, path, cause) => new MissionStoreError(message, code, path, cause),
        codes: {
            invalidId: 'invalid_mission_id',
            notFound: 'mission_missing',
            unsafeSource: 'mission_unsafe_source',
            readFailed: 'mission_read_failed',
        },
        entityNoun: 'Mission',
    });
}
