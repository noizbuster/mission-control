/**
 * Run store — JSON-backed CRUD for Run state objects with status-transition enforcement.
 *
 * Each Run is a single JSON file under `.omo/runs/{runId}.json`. Like Missions,
 * Runs are mutable state objects (not append-only event logs): writes replace
 * the file atomically. The allowed-transition state machine is enforced inside
 * `updateRunStatus`; direct field mutation is intentionally not exposed.
 *
 * Transition map (Task 1.4 contract):
 *   pending → running
 *   running → { blocked | completed | failed | cancelled }
 *   blocked → running
 *   terminal states (completed | failed | cancelled) have no outgoing edges.
 */

import { type Run, type RunCost, RunSchema, type RunStatus } from '@mission-control/protocol';
import { OmoPersistenceError, omoFilePath } from '../../persistence/paths.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RUNS_DIR = 'runs';
const JSON_EXTENSION = '.json';

/**
 * Allowed outgoing transitions for each RunStatus. Terminal statuses map to
 * empty arrays — once terminal, a Run cannot transition further.
 */
export const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    pending: ['running'],
    running: ['blocked', 'completed', 'failed', 'cancelled'],
    blocked: ['running'],
    completed: [],
    failed: [],
    cancelled: [],
};

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export class RunStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'RunStoreError';
    }
}

/**
 * Thrown when a `updateRunStatus` call requests a transition that is not in
 * {@linkcode ALLOWED_RUN_TRANSITIONS}. This is a domain-logic error (illegal
 * state-machine move), not a persistence error.
 */
export class MissionRunTransitionError extends Error {
    constructor(
        message: string,
        readonly fromStatus: RunStatus,
        readonly toStatus: RunStatus,
    ) {
        super(message);
        this.name = 'MissionRunTransitionError';
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
    await atomicWriteJson(runFilePath(root, validated.id), validated);
    return validated;
}

/**
 * Read and validate a Run by id. Throws `RunStoreError`
 * ({ code: 'run_missing' }) on ENOENT, ({ code: 'run_corrupt' }) on JSON/schema
 * validation failure.
 */
export async function readRun(root: string, runId: string): Promise<Run> {
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
        ...patch,
        status,
        ...(status === 'running' && existing.startedAt === undefined ? { startedAt: now } : {}),
        ...(TERMINAL_RUN_STATUSES.has(status) ? { endedAt: now } : {}),
    };

    const validated = RunSchema.parse(next);
    await atomicWriteJson(runFilePath(root, runId), validated);
    return validated;
}

/**
 * List all Runs belonging to `missionId`. Returns an empty array when the runs
 * directory does not exist yet. Throws on corrupt individual files.
 */
export async function listRunsForMission(root: string, missionId: string): Promise<readonly Run[]> {
    const dir = omoFilePath(root, RUNS_DIR);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }

    const runs: Run[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(JSON_EXTENSION)) {
            continue;
        }
        const runId = entry.slice(0, -JSON_EXTENSION.length);
        const run = await readRun(root, runId);
        if (run.missionId === missionId) {
            runs.push(run);
        }
    }
    return runs;
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
    if (from === to) {
        return;
    }
    const allowed = ALLOWED_RUN_TRANSITIONS[from];
    if (!allowed.includes(to)) {
        throw new MissionRunTransitionError(`Invalid run status transition: ${from} -> ${to}`, from, to);
    }
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
