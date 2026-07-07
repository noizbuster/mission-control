/**
 * Mission store — SQL-backed CRUD for Mission state objects.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/memory.db`.
 * During the compatibility window, missing SQL rows fall back to legacy
 * `.omo/missions/{missionId}.json` files and import them into SQL after schema
 * validation.
 */

import { type Mission, type MissionCapabilities, MissionSchema, type MissionStatus } from '@mission-control/protocol';
import { OmoPersistenceError, omoFilePath } from '../../persistence/paths.js';
import { listMissionsFromDb, readMissionFromDb, writeMissionToDb } from './mission-run-db.js';
import { readdir, readFile } from 'node:fs/promises';

const MISSIONS_DIR = 'missions';

export class MissionStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
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
    return omoFilePath(root, MISSIONS_DIR, `${missionId}.json`);
}

/**
 * Validate and persist a Mission atomically. The input is parsed through
 * `MissionSchema` before writing so malformed state is rejected at the boundary.
 */
export async function createMission(root: string, mission: Mission): Promise<Mission> {
    const validated = MissionSchema.parse(mission);
    await writeMissionToDb(root, validated);
    return validated;
}

/**
 * Read and validate a Mission by id. Throws `MissionStoreError`
 * ({ code: 'mission_missing' }) on ENOENT, ({ code: 'mission_corrupt' }) on
 * JSON/schema validation failure.
 */
export async function readMission(root: string, missionId: string): Promise<Mission> {
    const dbMission = await readMissionFromDb(root, missionId);
    if (dbMission !== undefined) {
        return dbMission;
    }
    const legacyMission = await readMissionJson(root, missionId);
    await writeMissionToDb(root, legacyMission);
    return legacyMission;
}

async function readMissionJson(root: string, missionId: string): Promise<Mission> {
    const filePath = missionFilePath(root, missionId);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            throw new MissionStoreError(
                `Mission ${missionId} not found at ${filePath}`,
                'mission_missing',
                filePath,
                error,
            );
        }
        throw new MissionStoreError(
            `Failed to read mission ${missionId} at ${filePath}`,
            'mission_read_failed',
            filePath,
            error,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        throw new MissionStoreError(
            `Mission ${missionId} at ${filePath} is not valid JSON`,
            'mission_corrupt',
            filePath,
            error,
        );
    }

    const result = MissionSchema.safeParse(parsed);
    if (!result.success) {
        const firstIssue = result.error.issues[0]?.message ?? 'unknown schema issue';
        throw new MissionStoreError(
            `Mission ${missionId} at ${filePath} failed validation: ${firstIssue}`,
            'mission_corrupt',
            filePath,
            result.error,
        );
    }
    return result.data;
}

/**
 * Read-modify-write a Mission. The patch is shallow-merged over the stored
 * Mission; `updatedAt` is refreshed to `now()`.
 */
export async function updateMission(
    root: string,
    missionId: string,
    patch: MissionPatch,
    options: { readonly now?: () => string } = {},
): Promise<Mission> {
    const now = options.now?.() ?? new Date().toISOString();
    const existing = await readMission(root, missionId);
    const updated: Mission = { ...existing, ...patch, updatedAt: now };
    const validated = MissionSchema.parse(updated);
    await writeMissionToDb(root, validated);
    return validated;
}

/**
 * List all persisted Missions. Returns an empty array when the missions
 * directory does not exist yet. Throws on corrupt individual files.
 */
export async function listMissions(root: string): Promise<readonly Mission[]> {
    const missions = [...(await listMissionsFromDb(root))];
    const seenIds = new Set(missions.map((mission) => mission.id));
    const dir = omoFilePath(root, MISSIONS_DIR);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return missions;
        }
        throw error;
    }

    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        const missionId = entry.slice(0, -JSON_EXTENSION.length);
        if (seenIds.has(missionId)) {
            continue;
        }
        const mission = await readMissionJson(root, missionId);
        await writeMissionToDb(root, mission);
        missions.push(mission);
        seenIds.add(mission.id);
    }
    return missions;
}

const JSON_EXTENSION = '.json';

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
