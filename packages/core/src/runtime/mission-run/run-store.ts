/**
 * Run store — SQL-backed CRUD for Run state objects with status-transition enforcement.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/memory.db`.
 * During the compatibility window, missing SQL rows fall back to legacy
 * `.omo/runs/{runId}.json` files and import them into SQL after schema validation.
 * The allowed-transition state machine is enforced inside `updateRunStatus`;
 * direct field mutation is intentionally not exposed.
 *
 * Transition map (Task 1.4 contract):
 *   pending → running
 *   running → { blocked | completed | failed | cancelled }
 *   blocked → running
 *   terminal states (completed | failed | cancelled) have no outgoing edges.
 */

import { type Run, type RunCost, RunSchema, type RunStatus, type TaskRetryState } from '@mission-control/protocol';
import { OmoPersistenceError, omoFilePath } from '../../persistence/paths.js';
import { findMostRecentFailedRunRecord } from './failed-run-store.js';
import { listRunsFromDb, readRunFromDb, writeRunToDb } from './mission-run-db.js';
import {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    MissionRunTransitionError,
    TERMINAL_RUN_STATUSES,
} from './run-status-transitions.js';
import { readdir, readFile } from 'node:fs/promises';

const RUNS_DIR = 'runs';
const JSON_EXTENSION = '.json';

export { ALLOWED_RUN_TRANSITIONS, assertRunTransition, MissionRunTransitionError, TERMINAL_RUN_STATUSES };

export class RunStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'RunStoreError';
    }
}

/**
 * Patchable Run fields accepted by `updateRunStatus`. Timestamps (`startedAt`,
 * `endedAt`) are intentionally absent — they are auto-managed by the transition
 * logic (`startedAt` on first →running, `endedAt` on →terminal).
 */
export type RunPatch = {
    readonly cost?: RunCost;
    readonly model?: Run['model'];
    readonly terminalReason?: string;
    readonly sessionId?: string;
    readonly graphId?: string;
    readonly attempt?: number;
    readonly childSessionIds?: readonly string[];
    readonly taskRetryState?: Readonly<Record<string, TaskRetryState>>;
};

export function runFilePath(root: string, runId: string): string {
    return omoFilePath(root, RUNS_DIR, `${runId}.json`);
}

/**
 * Validate and persist a Run atomically. The input is parsed through `RunSchema`
 * before writing so malformed state is rejected at the boundary.
 */
export async function createRun(root: string, run: Run): Promise<Run> {
    const validated = RunSchema.parse(run);
    await writeRunToDb(root, validated);
    return validated;
}

/**
 * Read and validate a Run by id. Throws `RunStoreError`
 * ({ code: 'run_missing' }) on ENOENT, ({ code: 'run_corrupt' }) on JSON/schema
 * validation failure.
 */
export async function readRun(root: string, runId: string): Promise<Run> {
    const dbRun = await readRunFromDb(root, runId);
    if (dbRun !== undefined) {
        return dbRun;
    }
    const legacyRun = await readRunJson(root, runId);
    await writeRunToDb(root, legacyRun);
    return legacyRun;
}

async function readRunJson(root: string, runId: string): Promise<Run> {
    const filePath = runFilePath(root, runId);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            throw new RunStoreError(`Run ${runId} not found at ${filePath}`, 'run_missing', filePath, error);
        }
        throw new RunStoreError(`Failed to read run ${runId} at ${filePath}`, 'run_read_failed', filePath, error);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        throw new RunStoreError(`Run ${runId} at ${filePath} is not valid JSON`, 'run_corrupt', filePath, error);
    }

    const result = RunSchema.safeParse(parsed);
    if (!result.success) {
        const firstIssue = result.error.issues[0]?.message ?? 'unknown schema issue';
        throw new RunStoreError(
            `Run ${runId} at ${filePath} failed validation: ${firstIssue}`,
            'run_corrupt',
            filePath,
            result.error,
        );
    }
    return result.data;
}

/**
 * Transition a Run to `status`, enforcing the allowed-transition map. The
 * optional `patch` is shallow-merged over the stored Run. `startedAt` is
 * auto-set on the first →running transition; `endedAt` is auto-set on any
 * →terminal transition. Throws `MissionRunTransitionError` on illegal moves.
 */
export async function updateRunStatus(
    root: string,
    runId: string,
    status: RunStatus,
    patch: RunPatch = {},
    options: { readonly now?: () => string } = {},
): Promise<Run> {
    const now = options.now?.() ?? new Date().toISOString();
    const existing = await readRun(root, runId);
    assertRunTransition(existing.status, status);

    const next: Run = {
        ...existing,
        ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.terminalReason !== undefined ? { terminalReason: patch.terminalReason } : {}),
        ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
        ...(patch.graphId !== undefined ? { graphId: patch.graphId } : {}),
        ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
        ...(patch.childSessionIds !== undefined ? { childSessionIds: [...patch.childSessionIds] } : {}),
        ...(patch.taskRetryState !== undefined ? { taskRetryState: { ...patch.taskRetryState } } : {}),
        status,
        ...(status === 'running' && existing.startedAt === undefined ? { startedAt: now } : {}),
        ...(TERMINAL_RUN_STATUSES.has(status) ? { endedAt: now } : {}),
    };

    const validated = RunSchema.parse(next);
    await writeRunToDb(root, validated);
    return validated;
}

/**
 * List all Runs belonging to `missionId`. Returns an empty array when the runs
 * directory does not exist yet. Throws on corrupt individual files.
 *
 * When `filter.parentId` is provided, only child Runs whose `parentRunId`
 * matches are returned. Without a filter, all Runs for the mission (including
 * children) are returned.
 */
export async function listRunsForMission(
    root: string,
    missionId: string,
    filter: { readonly parentId?: string } = {},
): Promise<readonly Run[]> {
    const runs = [
        ...(await listRunsFromDb(root, {
            missionId,
            ...(filter.parentId !== undefined ? { parentId: filter.parentId } : {}),
        })),
    ];
    const seenIds = new Set(runs.map((run) => run.id));
    const dir = omoFilePath(root, RUNS_DIR);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return runs;
        }
        throw error;
    }

    for (const entry of entries) {
        if (!entry.endsWith(JSON_EXTENSION)) {
            continue;
        }
        const runId = entry.slice(0, -JSON_EXTENSION.length);
        if (seenIds.has(runId)) {
            continue;
        }
        const run = await readRunJson(root, runId);
        if (run.missionId !== missionId) {
            continue;
        }
        if (filter.parentId !== undefined && run.parentRunId !== filter.parentId) {
            continue;
        }
        await writeRunToDb(root, run);
        runs.push(run);
        seenIds.add(run.id);
    }
    return runs;
}

/**
 * Find the most recently-ended `failed` Run. Used by `/retry` to re-invoke the last failed
 * workflow run. Scans every run file; returns the failed run with the latest `endedAt`.
 * Runs without `endedAt` sort before those with it. Returns `undefined` when there are no
 * failed runs (or no runs directory).
 */
export async function findMostRecentFailedRun(root: string): Promise<Run | undefined> {
    return findMostRecentFailedRunRecord(root);
}

export async function appendChildSession(root: string, runId: string, childSessionId: string): Promise<Run> {
    const existing = await readRun(root, runId);
    const existingChildren = existing.childSessionIds ?? [];
    if (existingChildren.includes(childSessionId)) {
        return existing;
    }
    const validated = RunSchema.parse({
        ...existing,
        childSessionIds: [...existingChildren, childSessionId],
    });
    await writeRunToDb(root, validated);
    return validated;
}

export async function recordTaskRetry(root: string, runId: string, taskKey: string, sessionId: string): Promise<Run> {
    const existing = await readRun(root, runId);
    const current = existing.taskRetryState ?? {};
    const priorEntry = current[taskKey];
    const nextEntry: TaskRetryState = {
        retryCount: (priorEntry?.retryCount ?? 0) + 1,
        lastSessionId: sessionId,
    };
    const validated = RunSchema.parse({
        ...existing,
        taskRetryState: { ...current, [taskKey]: nextEntry },
    });
    await writeRunToDb(root, validated);
    return validated;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
