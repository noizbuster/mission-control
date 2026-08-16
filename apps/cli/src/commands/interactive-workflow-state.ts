import {
    createMission,
    ensureMcDirs,
    listMissions,
    listRunsForMission,
    materializeMission,
    materializeWorkflow,
    type NormalizedMissionRunStoreLocation,
    normalizeMissionRunStoreLocation,
    type ObservabilityRedactor,
    resolveMcRoot,
    type SessionControlHost,
    startRun,
    TERMINAL_RUN_STATUSES,
    type WorkflowRegistry,
    workflowModePolicies,
} from '@mission-control/core';
import type {
    AbgGraphSpec,
    GraphCheckpoint,
    Mission,
    PolicyEffectRule,
    Run,
    WorkflowSpec,
} from '@mission-control/protocol';
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
    /** Active-mode policy rules paired with `graph` (two-layer enforcement). */
    readonly modePolicies?: readonly PolicyEffectRule[];
};

export type WorkflowSessionContinueBookkeeping = 'reuse_blocked' | 'started_new_run' | 'graph_only';

export type WorkflowSessionContinue = {
    readonly graph: AbgGraphSpec;
    /** Active-mode policy rules of the workflow the graph came from (two-layer enforcement). */
    readonly modePolicies?: readonly PolicyEffectRule[];
    readonly handle?: WorkflowRunHandle;
    readonly bookkeeping: WorkflowSessionContinueBookkeeping;
};

export type FindWorkflowGraphForSessionContinueInput = {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly sessionRunId?: string;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly checkpoint?: GraphCheckpoint;
    readonly prompt?: string;
    readonly sessionControlHost?: SessionControlHost;
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
    let mcRoot: string;
    try {
        mcRoot = await resolveMcRoot(workspaceRoot);
    } catch {
        return undefined;
    }
    await ensureMcDirs(mcRoot);
    const location = normalizeMissionRunStoreLocation({
        mcRoot,
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
    const continued = await findWorkflowGraphForSessionContinue(input);
    if (continued?.bookkeeping !== 'reuse_blocked' || continued.handle === undefined) return undefined;
    return {
        handle: continued.handle,
        graph: continued.graph,
        ...(continued.modePolicies !== undefined ? { modePolicies: continued.modePolicies } : {}),
    };
}

/**
 * Recover the executable workflow graph for a cold `/continue` without requiring
 * `run.status === 'blocked'` and without ever transitioning `cancelled → running`.
 *
 * Session events remain the source of truth for continuability; this helper only
 * resolves graph identity (mission/run linkage and/or checkpoint metadata) and
 * books a fresh SQL Run when the prior Mission Run is already terminal.
 */
export async function findWorkflowGraphForSessionContinue(
    input: FindWorkflowGraphForSessionContinueInput,
): Promise<WorkflowSessionContinue | undefined> {
    let mcRoot: string;
    try {
        mcRoot = await resolveMcRoot(input.workspaceRoot);
    } catch {
        return undefined;
    }
    const location = normalizeMissionRunStoreLocation({
        mcRoot,
        ...(input.observabilityRedactor !== undefined ? { observabilityRedactor: input.observabilityRedactor } : {}),
    });
    const linked = await findLinkedMissionRun(location, input);
    const graph = resolveContinueGraph(linked?.mission, input);
    if (graph === undefined) return undefined;
    const modePolicies = resolveContinueModePolicies(linked?.mission, input);
    if (linked === undefined) {
        return { graph, ...(modePolicies !== undefined ? { modePolicies } : {}), bookkeeping: 'graph_only' };
    }
    if (linked.run.status === 'blocked') {
        return {
            graph,
            ...(modePolicies !== undefined ? { modePolicies } : {}),
            handle: { location, missionId: linked.mission.id, runId: linked.run.id },
            bookkeeping: 'reuse_blocked',
        };
    }
    if (!TERMINAL_RUN_STATUSES.has(linked.run.status)) {
        return { graph, ...(modePolicies !== undefined ? { modePolicies } : {}), bookkeeping: 'graph_only' };
    }
    const prompt = input.prompt ?? linked.run.prompt ?? '';
    const nextRun = await startRun(location, linked.mission.id, prompt, {
        sessionId: input.sessionId,
        ...(input.sessionControlHost !== undefined ? { sessionControlHost: input.sessionControlHost } : {}),
    });
    return {
        graph,
        ...(modePolicies !== undefined ? { modePolicies } : {}),
        handle: { location, missionId: linked.mission.id, runId: nextRun.id },
        bookkeeping: 'started_new_run',
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

async function findLinkedMissionRun(
    location: NormalizedMissionRunStoreLocation,
    input: FindWorkflowGraphForSessionContinueInput,
): Promise<{ readonly mission: Mission; readonly run: Run } | undefined> {
    let selected: { readonly mission: Mission; readonly run: Run } | undefined;
    for (const mission of await listMissions(location)) {
        for (const run of await listRunsForMission(location, mission.id)) {
            if (!isMatchingSessionRun(run, mission.id, input)) continue;
            if (selected === undefined || (run.startedAt ?? '') > (selected.run.startedAt ?? '')) {
                selected = { mission, run };
            }
        }
    }
    return selected;
}

function isMatchingSessionRun(
    run: Run,
    missionId: string,
    input: { readonly sessionId: string; readonly sessionRunId?: string },
): boolean {
    if (run.missionId !== missionId || run.sessionId !== input.sessionId || run.parentRunId !== undefined) {
        return false;
    }
    if (input.sessionRunId === undefined) return true;
    return run.sessionRunId === input.sessionRunId;
}

function resolveContinueGraph(
    mission: Mission | undefined,
    input: FindWorkflowGraphForSessionContinueInput,
): AbgGraphSpec | undefined {
    if (mission?.graph !== undefined) return mission.graph;
    const workflowName = input.checkpoint?.workflowName ?? mission?.workflowName;
    if (workflowName !== undefined && input.workflowRegistry !== undefined) {
        const spec = input.workflowRegistry.lookup(workflowName);
        if (spec !== undefined) return materializeWorkflow(spec);
    }
    const graphId = input.checkpoint?.graphId ?? mission?.graphId;
    if (graphId !== undefined && input.workflowRegistry !== undefined) {
        for (const spec of input.workflowRegistry.list()) {
            if (spec.graph.id === graphId) return materializeWorkflow(spec);
        }
    }
    return undefined;
}

/**
 * Mode policy rules for the workflow a continue-graph came from. Mirrors
 * `resolveContinueGraph`'s spec lookup: mode rules are workflow-level, so they follow
 * the spec (by name, then by graph id) even when the graph itself came from the
 * persisted mission record.
 */
function resolveContinueModePolicies(
    mission: Mission | undefined,
    input: FindWorkflowGraphForSessionContinueInput,
): readonly PolicyEffectRule[] | undefined {
    if (input.workflowRegistry === undefined) return undefined;
    const workflowName = input.checkpoint?.workflowName ?? mission?.workflowName;
    if (workflowName !== undefined) {
        const spec = input.workflowRegistry.lookup(workflowName);
        if (spec !== undefined) return workflowModePolicies(spec);
    }
    const graphId = input.checkpoint?.graphId ?? mission?.graphId;
    if (graphId !== undefined) {
        for (const spec of input.workflowRegistry.list()) {
            if (spec.graph.id === graphId) return workflowModePolicies(spec);
        }
    }
    return undefined;
}
