import {
    AgentRuntime,
    listMissions,
    listRunsForMission,
    openLocalSessionEventStore,
    type ProviderAdapter,
    type SdkModelResolver,
    WorkflowRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import { expect, vi } from 'vitest';
import type { CodingActionContext } from './interactive-chat-actions';
import { runChatAction } from './interactive-chat-actions';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const currentSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const tempRoots: string[] = [];

export type WorkflowFixture = {
    readonly workspace: string;
    readonly dataDir: string;
    readonly sessionId: string;
    readonly registry: WorkflowRegistry;
    readonly spec: WorkflowSpec;
    readonly durableEvents: AgentEvent[];
    readonly emittedEvents: AgentEvent[];
};

export async function cleanupWorkflowFixtures(): Promise<void> {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function makeWorkflowFixture(suffix: string, spec: WorkflowSpec): Promise<WorkflowFixture> {
    const workspace = await mkdtemp(join(tmpdir(), `wf-owner-${suffix}-`));
    tempRoots.push(workspace);
    await mkdir(join(workspace, '.mc'), { recursive: true });
    const dataDir = join(workspace, 'data');
    vi.stubEnv('MCTRL_DATA_DIR', dataDir);
    return {
        workspace,
        dataDir,
        sessionId: `session_interactive_${suffix}`,
        registry: new WorkflowRegistry([spec]),
        spec,
        durableEvents: [],
        emittedEvents: [],
    };
}

export async function runWorkflow(
    fixture: WorkflowFixture,
    provider: ProviderAdapter,
    resolveSdkModel?: SdkModelResolver,
) {
    const coding = await makeCodingContext(fixture, provider, resolveSdkModel);
    return runChatAction(
        new AgentRuntime(),
        { write: () => undefined },
        { kind: 'workflow', name: fixture.spec.name, prompt: 'run workflow' },
        currentSelection,
        async () => undefined,
        [],
        coding,
    );
}

export async function makeCodingContext(
    fixture: WorkflowFixture,
    provider: ProviderAdapter,
    resolveSdkModel?: SdkModelResolver,
): Promise<CodingActionContext> {
    const sessionStore = await openLocalSessionEventStore({ dataDir: fixture.dataDir, sessionId: fixture.sessionId });
    return {
        activeTurn: undefined,
        useTui: false,
        commandExecutor: undefined,
        emitEvent: (event) => fixture.emittedEvents.push(event),
        nextTurnId: () => `turn_${fixture.sessionId}`,
        observeStoredEvent: (event) => fixture.durableEvents.push(event),
        provider,
        sessionId: fixture.sessionId,
        sessionStore,
        workspaceRoot: fixture.workspace,
        workflowRegistry: fixture.registry,
        ...(resolveSdkModel !== undefined ? { resolveSdkModel } : {}),
    };
}

export async function readOnlyRun(fixture: WorkflowFixture) {
    const location = { mcRoot: fixture.workspace, dataDir: fixture.dataDir };
    const missions = await listMissions(location);
    expect(missions).toHaveLength(1);
    const mission = missions[0];
    if (mission === undefined) throw new Error('expected persisted mission');
    const runs = await listRunsForMission(location, mission.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (run === undefined) throw new Error('expected persisted run');
    return run;
}

export function humanApprovalWorkflow(): WorkflowSpec {
    return {
        name: 'approval-workflow',
        graph: {
            id: 'approval-workflow-graph',
            entryNodeId: 'approval',
            nodes: [{ id: 'approval', kind: 'human-approval' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

export function llmWorkflow(): WorkflowSpec {
    return {
        name: 'llm-workflow',
        graph: {
            id: 'llm-workflow-graph',
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}
