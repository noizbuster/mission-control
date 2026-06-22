import { z } from 'zod';
import { OmoPersistenceError, omoFilePath } from './paths.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const BOULDER_FILE_NAME = 'boulder.json';

export const BOULDER_SCHEMA_VERSION = 2;

export const boulderWorkStatuses = ['pending', 'active', 'running', 'completed', 'failed', 'cancelled'] as const;
export type BoulderWorkStatus = (typeof boulderWorkStatuses)[number];

export const taskSessionStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type TaskSessionStatus = (typeof taskSessionStatuses)[number];

export const sessionOrigins = ['direct', 'appended'] as const;
export type SessionOrigin = (typeof sessionOrigins)[number];

/**
 * Runtime schema for a single task session entry inside a boulder work.
 * Fields are optional where the persisted shape is inconsistent across works.
 */
export const TaskSessionSchema = z
    .object({
        task_key: z.string().min(1),
        task_label: z.string().min(1),
        task_title: z.string(),
        session_id: z.string().min(1).optional(),
        agent: z.string().optional(),
        category: z.string().optional(),
        started_at: z.string().optional(),
        status: z.enum(taskSessionStatuses).optional(),
        updated_at: z.string().optional(),
        ended_at: z.string().optional(),
        elapsed_ms: z.number().int().nonnegative().optional(),
    })
    .passthrough();

export type TaskSession = z.infer<typeof TaskSessionSchema>;

/**
 * Runtime schema for a single boulder work entry. `passthrough` preserves
 * fields the orchestrator may add without forcing a schema bump here, since
 * the boulder file is authored by tooling outside this package.
 */
export const BoulderWorkSchema = z
    .object({
        work_id: z.string().min(1),
        active_plan: z.string().min(1),
        plan_name: z.string().min(1),
        status: z.enum(boulderWorkStatuses),
        started_at: z.string(),
        updated_at: z.string(),
        session_ids: z.array(z.string().min(1)),
        session_origins: z.record(z.string().min(1), z.enum(sessionOrigins)),
        agent: z.string().optional(),
        task_sessions: z.record(z.string().min(1), TaskSessionSchema).optional(),
        ended_at: z.string().optional(),
        elapsed_ms: z.number().nonnegative().optional(),
    })
    .passthrough();

export type BoulderWork = z.infer<typeof BoulderWorkSchema>;

/**
 * Schema for the top-level `.omo/boulder.json` payload. Mirrors the real file:
 * a version marker, an active work pointer (nullable), the works map, and a
 * denormalized projection of the active work at the top level.
 */
export const BoulderStateSchema = z
    .object({
        schema_version: z.literal(BOULDER_SCHEMA_VERSION),
        active_work_id: z.string().min(1).nullable(),
        works: z.record(z.string().min(1), BoulderWorkSchema),
        active_plan: z.string().optional(),
        plan_name: z.string().optional(),
        status: z.enum(boulderWorkStatuses).optional(),
        started_at: z.string().optional(),
        updated_at: z.string().optional(),
        session_ids: z.array(z.string().min(1)).optional(),
        session_origins: z.record(z.string().min(1), z.enum(sessionOrigins)).optional(),
        task_sessions: z.record(z.string().min(1), TaskSessionSchema).optional(),
        agent: z.string().optional(),
    })
    .passthrough();

export type BoulderState = z.infer<typeof BoulderStateSchema>;

/**
 * Patch shape accepted by `updateBoulderWork`. `task_sessions` entries are
 * merged key-by-key (new keys added, existing keys replaced). All other fields
 * shallow-merge over the stored work.
 */
export type BoulderWorkPatch = {
    readonly status?: BoulderWorkStatus;
    readonly active_plan?: string;
    readonly plan_name?: string;
    readonly agent?: string;
    readonly session_ids?: readonly string[];
    readonly session_origins?: Readonly<Record<string, SessionOrigin>>;
    readonly task_sessions?: Readonly<Record<string, TaskSession>>;
    readonly ended_at?: string;
    readonly elapsed_ms?: number;
};

export class BoulderStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'BoulderStoreError';
    }
}

export function boulderFilePath(root: string): string {
    return omoFilePath(root, BOULDER_FILE_NAME);
}

/**
 * Read and validate `.omo/boulder.json`. Returns `null` when the file does not
 * exist yet. Throws `BoulderStoreError` ({ code: 'boulder_corrupt' }) when the
 * file exists but fails JSON or schema validation.
 */
export async function readBoulder(root: string): Promise<BoulderState | null> {
    const filePath = boulderFilePath(root);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return null;
        }
        throw new BoulderStoreError(
            `Failed to read boulder state at ${filePath}`,
            'boulder_read_failed',
            filePath,
            error,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        throw new BoulderStoreError(
            `Boulder state at ${filePath} is not valid JSON`,
            'boulder_corrupt',
            filePath,
            error,
        );
    }

    const result = BoulderStateSchema.safeParse(parsed);
    if (!result.success) {
        const firstIssue = result.error.issues[0]?.message ?? 'unknown schema issue';
        throw new BoulderStoreError(
            `Boulder state at ${filePath} failed validation: ${firstIssue}`,
            'boulder_corrupt',
            filePath,
            result.error,
        );
    }
    return result.data;
}

/**
 * Validate and persist `state` to `.omo/boulder.json` atomically
 * (temp-file-then-rename). The input is parsed through `BoulderStateSchema`
 * before writing so malformed state is rejected at the boundary.
 */
export async function writeBoulder(root: string, state: BoulderState): Promise<void> {
    const filePath = boulderFilePath(root);
    const validated = BoulderStateSchema.parse(state);
    await atomicWriteJson(filePath, validated);
}

/**
 * Read-modify-write a single work in the boulder. The patch is shallow-merged
 * over the stored work; `task_sessions` is merged nested. `updated_at` is
 * refreshed to `now()`. Throws `BoulderStoreError` ({ code: 'boulder_work_missing' })
 * when `workId` is not present.
 */
export async function updateBoulderWork(
    root: string,
    workId: string,
    patch: BoulderWorkPatch,
    options: { readonly now?: () => string } = {},
): Promise<BoulderState> {
    const now = options.now?.() ?? new Date().toISOString();
    const state = await readBoulder(root);
    if (state === null) {
        throw new BoulderStoreError(
            `Cannot update work ${workId}: boulder.json is missing at ${boulderFilePath(root)}`,
            'boulder_missing',
            boulderFilePath(root),
        );
    }
    const existingWork = state.works[workId];
    if (existingWork === undefined) {
        throw new BoulderStoreError(
            `Cannot update work ${workId}: not present in boulder works`,
            'boulder_work_missing',
            boulderFilePath(root),
        );
    }

    const mergedTaskSessions = mergeTaskSessions(existingWork.task_sessions, patch.task_sessions);
    const nextWork: BoulderWork = {
        ...existingWork,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.active_plan !== undefined ? { active_plan: patch.active_plan } : {}),
        ...(patch.plan_name !== undefined ? { plan_name: patch.plan_name } : {}),
        ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
        ...(patch.session_ids !== undefined ? { session_ids: [...patch.session_ids] } : {}),
        ...(patch.session_origins !== undefined ? { session_origins: { ...patch.session_origins } } : {}),
        ...(mergedTaskSessions !== undefined ? { task_sessions: mergedTaskSessions } : {}),
        ...(patch.ended_at !== undefined ? { ended_at: patch.ended_at } : {}),
        ...(patch.elapsed_ms !== undefined ? { elapsed_ms: patch.elapsed_ms } : {}),
        updated_at: now,
    };

    const nextWorks = { ...state.works, [workId]: nextWork };
    const nextState: BoulderState = { ...state, works: nextWorks, updated_at: now };
    await writeBoulder(root, nextState);
    return nextState;
}

function mergeTaskSessions(
    existing: Readonly<Record<string, TaskSession>> | undefined,
    incoming: Readonly<Record<string, TaskSession>> | undefined,
): Record<string, TaskSession> | undefined {
    if (existing === undefined && incoming === undefined) {
        return undefined;
    }
    if (existing === undefined) {
        return { ...incoming };
    }
    if (incoming === undefined) {
        return { ...existing };
    }
    return { ...existing, ...incoming };
}

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
