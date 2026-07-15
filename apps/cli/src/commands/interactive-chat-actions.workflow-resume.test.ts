import {
    AgentRuntime,
    blockRun,
    createDeterministicProvider,
    createMission,
    materializeMission,
    openLocalSessionEventStore,
    readRun,
    startRun,
    WorkflowRegistry,
} from '@mission-control/core';
import type { ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingActionContext } from './interactive-chat-actions';
import { runChatAction } from './interactive-chat-actions';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resumeCodingAgentTurnMock = vi.hoisted(() =>
    vi.fn<typeof import('./interactive-coding-agent').resumeCodingAgentTurn>(),
);

vi.mock('./interactive-coding-agent.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./interactive-coding-agent')>()),
    resumeCodingAgentTurn: resumeCodingAgentTurnMock,
}));

const selection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const tempRoots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    resumeCodingAgentTurnMock.mockReset();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('interactive blocked workflow Run resume', () => {
    it('reattaches the original workflow graph and settles the blocked Run after /continue', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-run-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.omo'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_resume';
        const spec = workflowSpec();
        const location = { omoRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const running = await startRun(location, mission.id, 'resume me', { sessionId });
        await blockRun(location, running.id, { sessionId, sessionRunId: 'owner_resume' });
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendBlockedOwnerRun(sessionStore, sessionId, 'owner_resume');
        resumeCodingAgentTurnMock.mockImplementation(async (options) => {
            options.observeStoredEvent?.({
                type: 'run.started',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_resume', state: 'running' },
            });
            options.observeStoredEvent?.({
                type: 'run.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_resume', state: 'completed' },
            });
            options.emitEvent({
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                taskId: options.turnId,
                run: { runId: 'owner_resume', state: 'completed' },
            });
            return fakeActiveTurn();
        });
        const coding: CodingActionContext = {
            activeTurn: undefined,
            useTui: false,
            commandExecutor: undefined,
            emitEvent: undefined,
            nextTurnId: () => 'turn_workflow_resume',
            observeStoredEvent: undefined,
            provider: createDeterministicProvider([]),
            sessionId,
            sessionStore,
            workspaceRoot: workspace,
            workflowRegistry: new WorkflowRegistry([changedWorkflowSpec()]),
        };

        const result = await runChatAction(
            new AgentRuntime(),
            { write: () => undefined },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            coding,
        );
        await result.activeTurn?.done;

        expect(resumeCodingAgentTurnMock).toHaveBeenCalledWith(expect.objectContaining({ graph: spec.graph }));
        const completed = await readRun(location, running.id);
        expect(completed.status).toBe('completed');
        expect(completed.sessionRunId).toBe('owner_resume');
    });

    it('settles the resumed Run as failed when owner setup rejects', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-setup-failure-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.omo'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_resume_failure';
        const spec = workflowSpec();
        const location = { omoRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const running = await startRun(location, mission.id, 'resume me', { sessionId });
        await blockRun(location, running.id, { sessionId, sessionRunId: 'owner_resume_failure' });
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendBlockedOwnerRun(sessionStore, sessionId, 'owner_resume_failure');
        resumeCodingAgentTurnMock.mockRejectedValue(new Error('resume setup rejected'));

        await expect(
            runChatAction(
                new AgentRuntime(),
                { write: () => undefined },
                { kind: 'continue' },
                selection,
                async () => undefined,
                [],
                {
                    activeTurn: undefined,
                    useTui: false,
                    commandExecutor: undefined,
                    emitEvent: undefined,
                    nextTurnId: () => 'turn_workflow_resume_failure',
                    observeStoredEvent: undefined,
                    provider: createDeterministicProvider([]),
                    sessionId,
                    sessionStore,
                    workspaceRoot: workspace,
                    workflowRegistry: new WorkflowRegistry([spec]),
                },
            ),
        ).rejects.toThrow('resume setup rejected');

        const failed = await readRun(location, running.id);
        expect(failed.status).toBe('failed');
        expect(failed.terminalReason).toBe('workflow resume setup failed');
    });

    it('does not settle an older workflow Run when a newer plain owner Run is blocked', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-owner-binding-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.omo'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_owner_binding';
        const spec = workflowSpec();
        const location = { omoRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const running = await startRun(location, mission.id, 'older workflow', { sessionId });
        await blockRun(location, running.id, { sessionId, sessionRunId: 'owner_workflow' });
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendBlockedOwnerRun(sessionStore, sessionId, 'owner_workflow');
        await appendBlockedOwnerRun(sessionStore, sessionId, 'owner_plain');
        resumeCodingAgentTurnMock.mockImplementation(async (options) => {
            options.observeStoredEvent?.({
                type: 'run.started',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_plain', state: 'running' },
            });
            options.observeStoredEvent?.({
                type: 'run.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_plain', state: 'completed' },
            });
            return fakeActiveTurn();
        });

        const result = await runChatAction(
            new AgentRuntime(),
            { write: () => undefined },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            {
                activeTurn: undefined,
                useTui: false,
                commandExecutor: undefined,
                emitEvent: undefined,
                nextTurnId: () => 'turn_plain_resume',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([spec]),
            },
        );
        await result.activeTurn?.done;

        expect(resumeCodingAgentTurnMock).toHaveBeenCalledWith(expect.not.objectContaining({ graph: spec.graph }));
        expect((await readRun(location, running.id)).status).toBe('blocked');
    });
});

async function appendBlockedOwnerRun(
    sessionStore: Awaited<ReturnType<typeof openLocalSessionEventStore>>,
    sessionId: string,
    runId: string,
): Promise<void> {
    const timestamp = new Date().toISOString();
    await sessionStore.append({
        type: 'run.started',
        timestamp,
        sessionId,
        run: { runId, state: 'running' },
    });
    await sessionStore.append({
        type: 'run.blocked',
        timestamp,
        sessionId,
        run: { runId, state: 'blocked_on_approval' },
    });
}

function workflowSpec(): WorkflowSpec {
    return {
        name: 'resumable-workflow',
        graph: {
            id: 'resumable-workflow-graph',
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function changedWorkflowSpec(): WorkflowSpec {
    return {
        ...workflowSpec(),
        graph: {
            ...workflowSpec().graph,
            id: 'changed-after-block-graph',
        },
    };
}

function fakeActiveTurn() {
    return {
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
    };
}
