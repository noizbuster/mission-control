import {
    createMission,
    ensureOmoDirs,
    listMissions,
    listRunsForMission,
    materializeMission,
    type NormalizedMissionRunStoreLocation,
    normalizeMissionRunStoreLocation,
    type ObservabilityRedactor,
    resolveOmoRoot,
    startRun,
    type WorkflowRegistry,
} from '@mission-control/core';
import type { AbgGraphSpec, Mission, Run, WorkflowSpec } from '@mission-control/protocol';
import type { CodingActionContext } from './interactive-chat-action-context';
import type { PromptTurnContext } from './interactive-chat-prompt-turn';
import { settleNoninteractiveWorkflowRun, type WorkflowRunOutcome } from './run-agent-workflow-run';

export type WorkflowRunHandle = {
    readonly location: NormalizedMissionRunStoreLocation;
    readonly missionId: string;
    readonly runId: string;
};

export type ResumableWorkflowRun = {
    readonly handle: WorkflowRunHandle;
    readonly graph: AbgGraphSpec;
};

export async function tryCreateWorkflowRun(
    workspaceRoot: string | undefined,
    spec: WorkflowSpec,
    workflowGraph: AbgGraphSpec,
    prompt: string,
    sessionId: string | undefined,
    sessionControlHost?: NonNullable<PromptTurnContext['taskRuntimeServices']>['sessionControlHost'],
    observabilityRedactor?: ObservabilityRedactor,
): Promise<WorkflowRunHandle | undefined> {
    if (workspaceRoot === undefined) return undefined;
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(workspaceRoot);
    } catch {
        return undefined;
    }
    await ensureOmoDirs(omoRoot);
    const location = normalizeMissionRunStoreLocation({
        omoRoot,
        ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
    });
    const mission = materializeMission({ ...spec, graph: workflowGraph });
    await createMission(location, mission);
    const run = await startRun(location, mission.id, prompt, {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(sessionControlHost !== undefined ? { sessionControlHost } : {}),
    });
    return { location, missionId: mission.id, runId: run.id };
}

export async function settleWorkflowRun(
    handle: WorkflowRunHandle,
    outcome: WorkflowRunOutcome,
    sessionId?: string,
    sessionRunId?: string,
): Promise<void> {
    const attachment = sessionId === undefined || sessionRunId === undefined ? undefined : { sessionId, sessionRunId };
    await settleNoninteractiveWorkflowRun(handle, outcome, attachment);
}

export async function findResumableWorkflowRun(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly sessionRunId: string;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<ResumableWorkflowRun | undefined> {
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(input.workspaceRoot);
    } catch {
        return undefined;
    }
    const location = normalizeMissionRunStoreLocation({
        omoRoot,
        ...(input.observabilityRedactor !== undefined ? { observabilityRedactor: input.observabilityRedactor } : {}),
    });
    let selected: { readonly mission: Mission; readonly run: Run } | undefined;
    for (const mission of await listMissions(location)) {
        for (const run of await listRunsForMission(location, mission.id)) {
            if (!isMatchingBlockedRun(run, mission.id, input)) continue;
            if (selected === undefined || (run.startedAt ?? '') > (selected.run.startedAt ?? ''))
                selected = { mission, run };
        }
    }
    if (selected?.mission.graph === undefined) return undefined;
    return {
        handle: { location, missionId: selected.mission.id, runId: selected.run.id },
        graph: selected.mission.graph,
    };
}

export function seedOverlayForWorkflow(coding: CodingActionContext, graph: AbgGraphSpec): void {
    const controller = coding.abgOverlayController;
    if (controller === undefined) return;
    controller.store.update((draft) => {
        const nodes = new Map(draft.nodes);
        for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, 'idle');
        draft.activeGraphId = graph.id;
        draft.graphStatus = 'active';
        draft.nodes = nodes;
        draft.graphEdges = graph.edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
            ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
        }));
    });
}

function isMatchingBlockedRun(
    run: Run,
    missionId: string,
    input: { readonly sessionId: string; readonly sessionRunId: string },
): boolean {
    return (
        run.missionId === missionId &&
        run.status === 'blocked' &&
        run.sessionId === input.sessionId &&
        run.sessionRunId === input.sessionRunId &&
        run.parentRunId === undefined
    );
}
