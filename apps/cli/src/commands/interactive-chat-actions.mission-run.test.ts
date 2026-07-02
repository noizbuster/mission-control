import {
    AgentRuntime,
    createAllowPermissionDecision,
    createDeterministicProvider,
    listMissions,
    listRunsForMission,
    type ProviderAdapter,
    WorkflowRegistry,
} from '@mission-control/core';
import type { ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { runChatAction } from './interactive-chat-actions.js';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const currentSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workflow Mission/Run persistence', () => {
    it('creates a Mission and Run and settles as completed for a successful workflow turn', async () => {
        const workspace = await makeWorkspace();
        const provider = createDeterministicProvider([{ kind: 'response_completed', content: 'plan done' }]);
        const registry = new WorkflowRegistry([makeWorkflowSpec('planner')]);
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'workflow', name: 'planner', prompt: 'plan the migration' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider, workflowRegistry: registry }),
        );

        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(1);
        expect(missions[0]?.status).toBe('active');
        expect(missions[0]?.workflowName).toBe('planner');

        const runs = await listRunsForMission(workspace, missions[0]!.id);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe('completed');
    });

    it('settles the Run as failed when the workflow turn fails', async () => {
        const workspace = await makeWorkspace();
        const provider = createDeterministicProvider([
            { kind: 'response_failed', error: { code: 'unknown', message: 'boom', retryable: false } },
        ]);
        const registry = new WorkflowRegistry([makeWorkflowSpec('planner')]);
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'workflow', name: 'planner', prompt: 'plan x' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider, workflowRegistry: registry }),
        );

        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(1);
        const runs = await listRunsForMission(workspace, missions[0]!.id);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe('failed');
    });

    it('does NOT create records when a turn is already active (queue path)', async () => {
        const workspace = await makeWorkspace();
        const registry = new WorkflowRegistry([makeWorkflowSpec('planner')]);

        await runChatAction(
            new AgentRuntime(),
            createOutput(),
            { kind: 'workflow', name: 'planner', prompt: 'plan x' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({
                workspaceRoot: workspace,
                workflowRegistry: registry,
                activeTurn: fakeActiveTurn(),
            }),
        );

        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(0);
    });

    it('does NOT create records for a plain prompt (no # prefix)', async () => {
        const workspace = await makeWorkspace();
        const provider = createDeterministicProvider([{ kind: 'response_completed', content: 'hello' }]);
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'prompt', prompt: 'just a plain prompt' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider }),
        );

        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(0);
    });

    it('does NOT create records when the workspace has no .omo root', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'no-omo-'));
        tempRoots.push(workspace);
        const provider = createDeterministicProvider([{ kind: 'response_completed', content: 'ok' }]);
        const registry = new WorkflowRegistry([makeWorkflowSpec('planner')]);
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'workflow', name: 'planner', prompt: 'plan x' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider, workflowRegistry: registry }),
        );

        const entries = await readdir(workspace);
        expect(entries).not.toContain('.omo');
    });

    it('creates unique Mission and Run records across multiple sequential workflow turns', async () => {
        const workspace = await makeWorkspace();
        const registry = new WorkflowRegistry([makeWorkflowSpec('persist-demo')]);

        const provider1 = createDeterministicProvider([{ kind: 'response_completed', content: 'run 1' }]);
        const runtime1 = await makeStartedRuntime();
        await runChatAction(
            runtime1,
            createOutput(),
            { kind: 'workflow', name: 'persist-demo', prompt: 'first run' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider: provider1, workflowRegistry: registry }),
        );

        const provider2 = createDeterministicProvider([{ kind: 'response_completed', content: 'run 2' }]);
        const runtime2 = await makeStartedRuntime();
        await runChatAction(
            runtime2,
            createOutput(),
            { kind: 'workflow', name: 'persist-demo', prompt: 'second run' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, provider: provider2, workflowRegistry: registry }),
        );

        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(2);
        const missionIds = missions.map((m) => m.id);
        expect(new Set(missionIds).size).toBe(2);

        const firstMission = missions[0];
        const secondMission = missions[1];
        if (firstMission === undefined || secondMission === undefined) {
            throw new Error('expected two missions');
        }
        const runs1 = await listRunsForMission(workspace, firstMission.id);
        const runs2 = await listRunsForMission(workspace, secondMission.id);
        expect(runs1).toHaveLength(1);
        expect(runs2).toHaveLength(1);
        const firstRunId = runs1[0]?.id;
        const secondRunId = runs2[0]?.id;
        expect(firstRunId).toBeDefined();
        expect(secondRunId).toBeDefined();
        expect(firstRunId).not.toBe(secondRunId);
    });

    it('writes an unknown-workflow message and creates no records when the name is not found', async () => {
        const workspace = await makeWorkspace();
        const registry = new WorkflowRegistry([]);
        const runtime = await makeStartedRuntime();
        const output = createOutput();

        await runChatAction(
            runtime,
            output,
            { kind: 'workflow', name: 'ghost-workflow', prompt: 'x' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext({ workspaceRoot: workspace, workflowRegistry: registry }),
        );

        expect(output.getOutput()).toContain('Unknown workflow: ghost-workflow');
        const missions = await listMissions(workspace);
        expect(missions).toHaveLength(0);
    });
});

async function makeStartedRuntime(): Promise<AgentRuntime> {
    const runtime = new AgentRuntime({ permissionDecisionResolver: createAllowPermissionDecision });
    await runtime.start();
    return runtime;
}

async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'wf-mission-run-'));
    await mkdir(join(root, '.omo'), { recursive: true });
    tempRoots.push(root);
    return root;
}

function makeWorkflowSpec(name: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: `${name}-graph`,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function makeCodingContext(overrides: {
    readonly workspaceRoot: string;
    readonly provider?: ProviderAdapter;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly activeTurn?: NonNullable<CodingActionContext['activeTurn']>;
}): CodingActionContext {
    return {
        activeTurn: overrides.activeTurn,
        useTui: false,
        commandExecutor: undefined,
        emitEvent: undefined,
        nextTurnId: () => 'turn_test',
        observeStoredEvent: undefined,
        provider: overrides.provider,
        sessionId: undefined,
        sessionStore: undefined,
        workspaceRoot: overrides.workspaceRoot,
        ...(overrides.workflowRegistry !== undefined ? { workflowRegistry: overrides.workflowRegistry } : {}),
    };
}

function fakeActiveTurn(): NonNullable<CodingActionContext['activeTurn']> {
    return {
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
    };
}

function createOutput() {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        getOutput: () => chunks.join(''),
    };
}
