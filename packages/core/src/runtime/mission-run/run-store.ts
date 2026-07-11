/**
 * Run store — SQL-backed CRUD for Run state objects with status-transition enforcement.
 *
 * New writes go to the shared local libSQL database at `<data-dir>/memory.db`.
 * Exact legacy roots are migrated and ledgered before SQL operations begin.
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
import { OmoPersistenceError, omoFilePath } from '../../persistence/paths.js';
import { findMostRecentFailedRunRecord } from './failed-run-store.js';
import { listRunsFromDb, mutateRunInDb, mutateRunWithClient, readRunFromDb, writeRunToDb } from './mission-run-db.js';
import {
    ALLOWED_RUN_TRANSITIONS,
    assertRunTransition,
    MissionRunTransitionError,
    TERMINAL_RUN_STATUSES,
} from './run-status-transitions.js';

const RUNS_DIR = 'runs';

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
 * ({ code: 'run_missing' }) when no canonical row exists. Legacy migration
 * failures propagate without falling back to the JSON source.
 */
export async function readRun(root: string, runId: string): Promise<Run> {
    const dbRun = await readRunFromDb(root, runId);
    if (dbRun !== undefined) {
        return dbRun;
    }
    const filePath = runFilePath(root, runId);
    throw new RunStoreError(`Run ${runId} not found after runtime-store migration`, 'run_missing', filePath);
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
    return mutateStoredRun(root, runId, (existing) => transitionedRun(existing, status, patch, now));
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
    root: string,
    missionId: string,
    filter: { readonly parentId?: string } = {},
): Promise<readonly Run[]> {
    return listRunsFromDb(root, {
        missionId,
        ...(filter.parentId !== undefined ? { parentId: filter.parentId } : {}),
    });
}

/**
 * Find the most recently-ended `failed` Run. Used by `/retry` to re-invoke the last failed
 * workflow run from the canonical SQL store.
 * Runs without `endedAt` sort before those with it. Returns `undefined` when there are no
 * failed rows.
 */
export async function findMostRecentFailedRun(root: string): Promise<Run | undefined> {
    return findMostRecentFailedRunRecord(root);
}

export async function appendChildSession(root: string, runId: string, childSessionId: string): Promise<Run> {
    return mutateStoredRun(root, runId, (existing) => {
        const existingChildren = existing.childSessionIds ?? [];
        if (existingChildren.includes(childSessionId)) return existing;
        return RunSchema.parse({
            ...existing,
            childSessionIds: [...existingChildren, childSessionId],
        });
    });
}

export async function recordTaskRetry(root: string, runId: string, taskKey: string, sessionId: string): Promise<Run> {
    return mutateStoredRun(root, runId, (existing) => {
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

async function mutateStoredRun(root: string, runId: string, mutate: (run: Run) => Run): Promise<Run> {
    const updated = await mutateRunInDb(root, runId, mutate);
    if (updated !== undefined) return updated;
    throw new RunStoreError(
        `Run ${runId} not found after runtime-store migration`,
        'run_missing',
        runFilePath(root, runId),
    );
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
