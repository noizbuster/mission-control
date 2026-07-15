/**
 * Mission-Run service — materializes Missions from WorkflowSpecs and orchestrates
 * Run lifecycle transitions through the mission/run stores.
 *
 * `materializeMission` is a pure factory (no I/O): it builds a valid Mission from
 * a WorkflowSpec's graph, capabilities, and modes. The caller persists it via
 * `createMission`. The public lifecycle functions (`startRun`, `blockRun`,
 * `cancelRun`, `completeRun`, `failRun`) are async store orchestrators that
 * enforce the Run state machine. A blocked Run is nonterminal and may resume or
 * be cancelled; cancellation is terminal, records a reason, and receives an
 * auto-managed `endedAt` timestamp.
 */

import {
    type Mission,
    type MissionCapabilities,
    MissionSchema,
    type ModeDeclaration,
    type Run,
    type RunCost,
    RunSchema,
    type RunStatus,
    type TaskRetryState,
    type WorkflowSpec,
} from '@mission-control/protocol';
import type { SessionControlAttachment, SessionControlHost } from '../session-control-host.js';
import { type MissionRunStoreLocation, normalizeMissionRunStoreLocation } from './mission-run-store-location.js';
import { readMission, updateMission } from './mission-store.js';
import {
    type RunSessionOwnerAttachment,
    type RunSessionOwnerSettlement,
    settleRunSessionOwner,
} from './run-session-owner-store.js';
import { createRun, type RunPatch, TERMINAL_RUN_STATUSES, updateRunStatus } from './run-store.js';
import { randomUUID } from 'node:crypto';

const missionRunAttachments = new Map<string, SessionControlAttachment>();

/**
 * Optional inputs for completing a Run. `cost` replaces the Run's accumulated
 * cost (the caller is responsible for accumulation); `terminalReason` records
 * the human-readable completion note; `model` snapshots the resolved model.
 */
export type RunCompletionInput = {
    readonly cost?: RunCost;
    readonly terminalReason?: string;
    readonly model?: Run['model'];
    readonly childSessionIds?: readonly string[];
    readonly taskRetryState?: Readonly<Record<string, TaskRetryState>>;
};

/**
 * Create a draft Mission from a WorkflowSpec. Capabilities are derived from the
 * union of category permissions; mode declarations from active mode bindings;
 * policies are inherited from the graph's own ABG policies. The returned Mission
 * has `status: 'draft'` — the caller transitions it to `active` via `startRun`.
 */
export function materializeMission(workflowSpec: WorkflowSpec): Mission {
    const now = new Date().toISOString();
    const modeDeclarations = deriveModeDeclarations(workflowSpec);

    return MissionSchema.parse({
        id: randomUUID(),
        name: workflowSpec.name,
        ...(workflowSpec.description !== undefined ? { description: workflowSpec.description } : {}),
        status: 'draft',
        graph: workflowSpec.graph,
        workflowName: workflowSpec.name,
        capabilities: deriveCapabilities(workflowSpec),
        policies: workflowSpec.graph.policies,
        ...(modeDeclarations !== undefined ? { modeDeclarations } : {}),
        createdAt: now,
        updatedAt: now,
    });
}

/**
 * Start a Run for `missionId`. Creates the Run in `pending`, transitions it to
 * `running` (enforcing the state machine), optionally links the actual session,
 * persists
 * the initiating `prompt` (so `/retry` can re-invoke it), and transitions the
 * parent Mission to `active`.
 */
export async function startRun(
    location: MissionRunStoreLocation,
    missionId: string,
    prompt: string,
    options: { readonly sessionId?: string; readonly sessionControlHost?: SessionControlHost } = {},
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const mission = await readMission(normalized, missionId);

    const pendingRun = RunSchema.parse({
        id: randomUUID(),
        missionId: mission.id,
        status: 'pending' as RunStatus,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        prompt,
    });
    const attachment =
        options.sessionControlHost !== undefined && options.sessionId !== undefined
            ? await options.sessionControlHost.attachEntity({
                  sessionId: options.sessionId,
                  kind: 'mission_run',
                  entityId: pendingRun.id,
                  handles: [],
              })
            : undefined;
    let runPersisted = false;
    try {
        await createRun(normalized, pendingRun);
        runPersisted = true;
        const runningRun = await updateRunStatus(normalized, pendingRun.id, 'running');
        await updateMission(normalized, mission.id, { status: 'active' });
        if (attachment !== undefined) missionRunAttachments.set(pendingRun.id, attachment);
        return runningRun;
    } catch (error: unknown) {
        if (runPersisted) {
            await updateRunStatus(normalized, pendingRun.id, 'cancelled', {
                terminalReason: 'run setup failed',
            });
        }
        await attachment?.detach();
        throw error;
    }
}

export async function blockRun(
    location: MissionRunStoreLocation,
    runId: string,
    attachment?: RunSessionOwnerAttachment,
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    return attachment === undefined
        ? updateRunStatus(normalized, runId, 'blocked')
        : settleMissionRunSessionOwner(normalized, runId, attachment, { status: 'blocked' });
}

export async function settleMissionRunSessionOwner(
    location: MissionRunStoreLocation,
    runId: string,
    attachment: RunSessionOwnerAttachment,
    settlement: RunSessionOwnerSettlement,
): Promise<Run> {
    const settled = await settleRunSessionOwner(location, runId, attachment, settlement);
    if (TERMINAL_RUN_STATUSES.has(settled.status)) await detachMissionRun(runId);
    return settled;
}

export async function cancelRun(location: MissionRunStoreLocation, runId: string, reason: string): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const cancelled = await updateRunStatus(normalized, runId, 'cancelled', { terminalReason: reason });
    await detachMissionRun(runId);
    return cancelled;
}

/**
 * Transition a Run from `running` to `completed`, recording cost and terminal
 * reason. Throws `MissionRunTransitionError` if the Run is not currently running.
 */
export async function completeRun(
    location: MissionRunStoreLocation,
    runId: string,
    result: RunCompletionInput = {},
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const patch: RunPatch = {
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.terminalReason !== undefined ? { terminalReason: result.terminalReason } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.childSessionIds !== undefined ? { childSessionIds: result.childSessionIds } : {}),
        ...(result.taskRetryState !== undefined ? { taskRetryState: result.taskRetryState } : {}),
    };
    const completed = await updateRunStatus(normalized, runId, 'completed', patch);
    await detachMissionRun(runId);
    return completed;
}

/**
 * Transition a Run from `running` to `failed`, recording the failure reason as
 * `terminalReason`. Throws `MissionRunTransitionError` if the Run is not
 * currently running.
 */
export async function failRun(
    location: MissionRunStoreLocation,
    runId: string,
    reason: string,
    result: Omit<RunCompletionInput, 'terminalReason'> = {},
): Promise<Run> {
    const normalized = normalizeMissionRunStoreLocation(location);
    const patch: RunPatch = {
        terminalReason: reason,
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.childSessionIds !== undefined ? { childSessionIds: result.childSessionIds } : {}),
        ...(result.taskRetryState !== undefined ? { taskRetryState: result.taskRetryState } : {}),
    };
    const failed = await updateRunStatus(normalized, runId, 'failed', patch);
    await detachMissionRun(runId);
    return failed;
}

async function detachMissionRun(runId: string): Promise<void> {
    const attachment = missionRunAttachments.get(runId);
    missionRunAttachments.delete(runId);
    await attachment?.detach();
}

export async function releaseMissionRunControlAttachment(runId: string): Promise<void> {
    await detachMissionRun(runId);
}

function deriveCapabilities(workflowSpec: WorkflowSpec): MissionCapabilities {
    const categories = workflowSpec.categories;
    if (categories === undefined || categories.length === 0) {
        return { allow: [], deny: [] };
    }
    const allow = new Set<string>();
    for (const category of categories) {
        for (const permission of category.permissions) {
            allow.add(permission);
        }
    }
    return { allow: [...allow], deny: [] };
}

function deriveModeDeclarations(workflowSpec: WorkflowSpec): ModeDeclaration[] | undefined {
    const modes = workflowSpec.modes;
    if (modes === undefined || modes.length === 0) {
        return undefined;
    }
    return modes.map((mode) => ({ modeId: mode.id, active: true }));
}
