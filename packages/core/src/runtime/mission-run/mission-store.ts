/**
 * Mission store — JSON-backed CRUD for Mission state objects.
 *
 * Each Mission is a single JSON file under `.omo/missions/{missionId}.json`.
 * Unlike session event logs (append-only JSONL), a Mission is a mutable state
 * object: writes replace the file atomically (temp-file-then-rename). Reads
 * validate through `MissionSchema` to reject corruption at the boundary.
 */

import { type Mission, type MissionCapabilities, MissionSchema, type MissionStatus } from '@mission-control/protocol';
import { OmoPersistenceError, omoFilePath } from '../../persistence/paths.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
    await atomicWriteJson(missionFilePath(root, validated.id), validated);
    return validated;
}

/**
 * Read and validate a Mission by id. Throws `MissionStoreError`
 * ({ code: 'mission_missing' }) on ENOENT, ({ code: 'mission_corrupt' }) on
 * JSON/schema validation failure.
 */
export async function readMission(root: string, missionId: string): Promise<Mission> {
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
    await atomicWriteJson(missionFilePath(root, missionId), validated);
    return validated;
}

/**
 * List all persisted Missions. Returns an empty array when the missions
 * directory does not exist yet. Throws on corrupt individual files.
 */
export async function listMissions(root: string): Promise<readonly Mission[]> {
    const dir = omoFilePath(root, MISSIONS_DIR);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }

    const missions: Mission[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        const missionId = entry.slice(0, -JSON_EXTENSION.length);
        missions.push(await readMission(root, missionId));
    }
    return missions;
}

const JSON_EXTENSION = '.json';

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
    await rm(tempPath, { force: true });
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
