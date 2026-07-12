/**
 * Run store — SQL-backed CRUD for Run state objects with status-transition enforcement.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/mission-control.db`.
 * Missing SQL rows may fall back to `.omo/runs/{runId}.json` compatibility records
 * owned by this store. Database startup never probes an older SQL file.
 * The allowed-transition state machine is enforced inside `updateRunStatus`;
 * direct field mutation is intentionally not exposed.
 *
 * Transition map (Task 1.4 contract):
 *   pending → running
 *   running → { blocked | completed | failed | cancelled }
 *   blocked → running
 *   terminal states (completed | failed | cancelled) have no outgoing edges.
 */

import type { Client } from '@libsql/client';
import { type Run, type RunCost, RunSchema, type RunStatus, type TaskRetryState } from '@mission-control/protocol';
import { findMostRecentFailedRunRecord } from './failed-run-store.js';
import { listRunsFromDb, mutateRunInDb, mutateRunWithClient, readRunFromDb, writeRunToDb } from './mission-run-db.js';
import { type MissionRunStoreLocation, normalizeMissionRunStoreLocation } from './mission-run-store-location.js';
import {
    compatibleRunFilePath,
    listCompatibleRunJsonRecords,
    RunStoreError,
    readCompatibleRunJsonRecord,
} from './run-json-compatibility.js';
import {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    MissionRunTransitionError,
    TERMINAL_RUN_STATUSES,
} from './run-status-transitions.js';

export {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    MissionRunTransitionError,
    RunStoreError,
    TERMINAL_RUN_STATUSES,
};

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
    return compatibleRunFilePath(root, runId);
}

/**
 * Validate and persist a Run atomically. The input is parsed through `RunSchema`
 * before writing so malformed state is rejected at the boundary.
 */
export async function createRun(location: MissionRunStoreLocation, run: Run): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const validated = RunSchema.parse(run);
    await writeRunToDb(normalized.dataDir, validated);
    return validated;
}

/**
 * Read and validate a Run by id. Throws `RunStoreError`
 * ({ code: 'run_missing' }) when neither a canonical row nor a compatible JSON
 * record exists.
 */
export async function readRun(location: MissionRunStoreLocation, runId: string): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const dbRun = await readRunFromDb(normalized.dataDir, runId);
    if (dbRun !== undefined) {
        return dbRun;
    }
    const jsonRun = await readCompatibleRunJsonRecord(normalized.omoRoot, runId);
    await writeRunToDb(normalized.dataDir, jsonRun);
    return jsonRun;
}

/**
 * Transition a Run to `status`, enforcing the allowed-transition map. The
 * optional `patch` is shallow-merged over the stored Run. `startedAt` is
 * auto-set on the first →running transition; `endedAt` is auto-set on any
 * →terminal transition. Throws `MissionRunTransitionError` on illegal moves.
 */
export async function updateRunStatus(
    location: MissionRunStoreLocation,
    runId: string,
    status: RunStatus,
    patch: RunPatch = {},
    options: { readonly now?: () => string } = {},
): Promise<Run> {
    const now = options.now?.() ?? new Date().toISOString();
    return mutateStoredRun(location, runId, (existing) => transitionedRun(existing, status, patch, now));
}

export async function updateRunStatusWithClient(
    client: Client,
    runId: string,
    status: RunStatus,
    patch: RunPatch = {},
    options: { readonly now?: () => string } = {},
): Promise<Run | undefined> {
    const now = options.now?.() ?? new Date().toISOString();
    return mutateRunWithClient(client, runId, (existing) => transitionedRun(existing, status, patch, now), now);
}

/**
 * List all Runs belonging to `missionId`. Returns an empty array when no rows exist.
 *
 * When `filter.parentId` is provided, only child Runs whose `parentRunId`
 * matches are returned. Without a filter, all Runs for the mission (including
 * children) are returned.
 */
export async function listRunsForMission(
    location: MissionRunStoreLocation,
    missionId: string,
    filter: { readonly parentId?: string } = {},
): Promise<readonly Run[]> {
    return (await listAllRuns(location)).filter(
        (run) => run.missionId === missionId && (filter.parentId === undefined || run.parentRunId === filter.parentId),
    );
}

/**
 * Find the most recently-ended `failed` Run. Used by `/retry` to re-invoke the last failed
 * workflow run from the canonical SQL store.
 * Runs without `endedAt` sort before those with it. Returns `undefined` when there are no
 * failed rows.
 */
export async function findMostRecentFailedRun(location: MissionRunStoreLocation): Promise<Run | undefined> {
    return findMostRecentFailedRunRecord(await listAllRuns(location));
}

export async function appendChildSession(
    location: MissionRunStoreLocation,
    runId: string,
    childSessionId: string,
): Promise<Run> {
    return mutateStoredRun(location, runId, (existing) => {
        const existingChildren = existing.childSessionIds ?? [];
        if (existingChildren.includes(childSessionId)) return existing;
        return RunSchema.parse({
            ...existing,
            childSessionIds: [...existingChildren, childSessionId],
        });
    });
}

export async function recordTaskRetry(
    location: MissionRunStoreLocation,
    runId: string,
    taskKey: string,
    sessionId: string,
): Promise<Run> {
    return mutateStoredRun(location, runId, (existing) => {
        const current = existing.taskRetryState ?? {};
        const priorEntry = current[taskKey];
        const nextEntry: TaskRetryState = {
            retryCount: (priorEntry?.retryCount ?? 0) + 1,
            lastSessionId: sessionId,
        };
        return RunSchema.parse({
            ...existing,
            taskRetryState: { ...current, [taskKey]: nextEntry },
        });
    });
}

async function mutateStoredRun(
    location: MissionRunStoreLocation,
    runId: string,
    mutate: (run: Run) => Run,
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    let updated = await mutateRunInDb(normalized.dataDir, runId, mutate);
    if (updated !== undefined) return updated;
    const jsonRun = await readCompatibleRunJsonRecord(normalized.omoRoot, runId);
    await writeRunToDb(normalized.dataDir, jsonRun);
    updated = await mutateRunInDb(normalized.dataDir, runId, mutate);
    if (updated !== undefined) return updated;
    throw new RunStoreError(`Run ${runId} could not be loaded`, 'run_missing', runFilePath(normalized.omoRoot, runId));
}

async function listAllRuns(location: MissionRunStoreLocation): Promise<readonly Run[]> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const runs = [...(await listRunsFromDb(normalized.dataDir))];
    const seenIds = new Set(runs.map((run) => run.id));
    for (const run of await listCompatibleRunJsonRecords(normalized.omoRoot, seenIds)) {
        await writeRunToDb(normalized.dataDir, run);
        runs.push(run);
        seenIds.add(run.id);
    }
    return runs;
}

function transitionedRun(existing: Run, status: RunStatus, patch: RunPatch, now: string): Run {
    assertRunTransition(existing.status, status);
    return RunSchema.parse({
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
    });
}
