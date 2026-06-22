/**
 * Mission-Run service — materializes Missions from WorkflowSpecs and orchestrates
 * Run lifecycle transitions through the mission/run stores.
 *
 * `materializeMission` is a pure factory (no I/O): it builds a valid Mission from
 * a WorkflowSpec's graph, capabilities, and modes. The caller persists it via
 * `createMission`. The remaining functions (`startRun`, `completeRun`, `failRun`)
 * are async store orchestrators that enforce the Run state machine and keep the
 * parent Mission's status in sync.
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
    type WorkflowSpec,
} from '@mission-control/protocol';
import { readMission, updateMission } from './mission-store.js';
import { createRun, type RunPatch, updateRunStatus } from './run-store.js';
import { randomUUID } from 'node:crypto';

/**
 * Optional inputs for completing a Run. `cost` replaces the Run's accumulated
 * cost (the caller is responsible for accumulation); `terminalReason` records
 * the human-readable completion note; `model` snapshots the resolved model.
 */
export type RunCompletionInput = {
    readonly cost?: RunCost;
    readonly terminalReason?: string;
    readonly model?: Run['model'];
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
 * `running` (enforcing the state machine), links a fresh `sessionId`, and
 * transitions the parent Mission to `active`. The `prompt` parameter is the
 * initiating user prompt — accepted for forward compatibility with session
 * admission wiring (a later task); not persisted in the Run record itself.
 */
export async function startRun(
    root: string,
    missionId: string,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for session admission wiring (Task 1.5)
    prompt: string,
): Promise<Run> {
    const mission = await readMission(root, missionId);
    const sessionId = randomUUID();

    const pendingRun = RunSchema.parse({
        id: randomUUID(),
        missionId: mission.id,
        status: 'pending' as RunStatus,
        sessionId,
    });
    await createRun(root, pendingRun);

    const runningRun = await updateRunStatus(root, pendingRun.id, 'running');

    await updateMission(root, mission.id, { status: 'active' });

    return runningRun;
}

/**
 * Transition a Run from `running` to `completed`, recording cost and terminal
 * reason. Throws `MissionRunTransitionError` if the Run is not currently running.
 */
export async function completeRun(root: string, runId: string, result: RunCompletionInput = {}): Promise<Run> {
    const patch: RunPatch = {
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.terminalReason !== undefined ? { terminalReason: result.terminalReason } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
    };
    return updateRunStatus(root, runId, 'completed', patch);
}

/**
 * Transition a Run from `running` to `failed`, recording the failure reason as
 * `terminalReason`. Throws `MissionRunTransitionError` if the Run is not
 * currently running.
 */
export async function failRun(root: string, runId: string, reason: string): Promise<Run> {
    return updateRunStatus(root, runId, 'failed', { terminalReason: reason });
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
