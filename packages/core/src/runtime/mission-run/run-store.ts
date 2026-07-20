/**
 * Run store — SQL-backed CRUD for Run state objects with status-transition enforcement.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/mission-control.db`.
 * Missing SQL rows may fall back to `.mc/runs/{runId}.json` compatibility records
 * owned by this store. Database startup never probes an older SQL file.
 * The allowed-transition state machine is enforced inside `updateRunStatus`;
 * direct field mutation is intentionally not exposed.
 *
 * Transition map (Task 1.4 contract):
 *   pending → { running | cancelled }
 *   running → { blocked | completed | failed | cancelled }
 *   blocked → { running | cancelled }
 *   terminal states (completed | failed | cancelled) have no outgoing edges.
 */

import type { Client } from '@libsql/client';
import { type Run, type RunCost, RunSchema, type RunStatus, type TaskRetryState } from '@mission-control/protocol';
import type { ObservabilityRedactor } from '../../providers/observability-redactor';
import { findMostRecentFailedRunRecord } from './failed-run-store';
import { listRunsFromDb, mutateRunInDb, mutateRunWithClient, readRunFromDb, writeRunToDb } from './mission-run-db';
import { type MissionRunStoreLocation, normalizeMissionRunStoreLocation } from './mission-run-store-location';
import {
    compatibleRunFilePath,
    listCompatibleRunJsonRecords,
    RunStoreError,
    readCompatibleRunJsonRecord,
} from './run-json-compatibility';
import { sanitizeRunForPersistence, sanitizeTerminalReason } from './run-persistence-sanitization';
import { runWithoutSessionOwnerAuthority } from './run-session-owner-authority';
import {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    MissionRunTransitionError,
    TERMINAL_RUN_STATUSES,
} from './run-status-transitions';

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
    const validated = sanitizeRunForPersistence(runWithoutSessionOwnerAuthority(run), normalized.observabilityRedactor);
    const created = await writeRunToDb(normalized.dataDir, validated, { conflict: 'ignore' });
    if (!created) throw new RunStoreError(`Run ${validated.id} already exists`, 'run_exists');
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
        return sanitizeRunForPersistence(dbRun, normalized.observabilityRedactor);
    }
    const jsonRun = sanitizeRunForPersistence(
        await readCompatibleRunJsonRecord(normalized.mcRoot, runId),
        normalized.observabilityRedactor,
    );
    await writeRunToDb(normalized.dataDir, jsonRun, { conflict: 'ignore' });
    const imported = await readRunFromDb(normalized.dataDir, runId);
    if (imported === undefined) {
        throw new RunStoreError(
            `Run ${runId} could not be imported`,
            'run_missing',
            runFilePath(normalized.mcRoot, runId),
        );
    }
    return sanitizeRunForPersistence(imported, normalized.observabilityRedactor);
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
    return mutateStoredRun(location, runId, (existing) => transitionStoredRun(existing, status, patch, now));
}

export async function updateRunStatusWithClient(
    client: Client,
    runId: string,
    status: RunStatus,
    patch: RunPatch = {},
    options: { readonly now?: () => string; readonly observabilityRedactor?: ObservabilityRedactor } = {},
): Promise<Run | undefined> {
    const now = options.now?.() ?? new Date().toISOString();
    const updated = await mutateRunWithClient(
        client,
        runId,
        (existing) =>
            sanitizeRunForPersistence(transitionStoredRun(existing, status, patch, now), options.observabilityRedactor),
        now,
    );
    return updated === undefined ? undefined : sanitizeRunForPersistence(updated, options.observabilityRedactor);
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

export async function mutateStoredRun(
    location: MissionRunStoreLocation,
    runId: string,
    mutate: (run: Run) => Run,
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const sanitizeMutation = (run: Run) => sanitizeRunForPersistence(mutate(run), normalized.observabilityRedactor);
    let updated = await mutateRunInDb(normalized.dataDir, runId, sanitizeMutation);
    if (updated !== undefined) return sanitizeRunForPersistence(updated, normalized.observabilityRedactor);
    const jsonRun = sanitizeRunForPersistence(
        await readCompatibleRunJsonRecord(normalized.mcRoot, runId),
        normalized.observabilityRedactor,
    );
    await writeRunToDb(normalized.dataDir, jsonRun, { conflict: 'ignore' });
    updated = await mutateRunInDb(normalized.dataDir, runId, sanitizeMutation);
    if (updated !== undefined) return sanitizeRunForPersistence(updated, normalized.observabilityRedactor);
    throw new RunStoreError(`Run ${runId} could not be loaded`, 'run_missing', runFilePath(normalized.mcRoot, runId));
}

async function listAllRuns(location: MissionRunStoreLocation): Promise<readonly Run[]> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const runs = (await listRunsFromDb(normalized.dataDir)).map((run) =>
        sanitizeRunForPersistence(run, normalized.observabilityRedactor),
    );
    const seenIds = new Set(runs.map((run) => run.id));
    for (const compatibleRun of await listCompatibleRunJsonRecords(normalized.mcRoot, seenIds)) {
        const run = sanitizeRunForPersistence(compatibleRun, normalized.observabilityRedactor);
        await writeRunToDb(normalized.dataDir, run, { conflict: 'ignore' });
        const imported = await readRunFromDb(normalized.dataDir, run.id);
        if (imported === undefined) {
            throw new RunStoreError(
                `Run ${run.id} could not be imported`,
                'run_missing',
                runFilePath(normalized.mcRoot, run.id),
            );
        }
        const canonical = sanitizeRunForPersistence(imported, normalized.observabilityRedactor);
        runs.push(canonical);
        seenIds.add(canonical.id);
    }
    return runs;
}

export function transitionStoredRun(existing: Run, status: RunStatus, patch: RunPatch, now: string): Run {
    assertRunTransition(existing.status, status);
    if (existing.status === status) return existing;
    const { terminalReason: _terminalReason, ...base } = existing;
    return RunSchema.parse({
        ...base,
        ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(TERMINAL_RUN_STATUSES.has(status) && patch.terminalReason !== undefined
            ? { terminalReason: sanitizeTerminalReason(patch.terminalReason) }
            : {}),
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
