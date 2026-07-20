import {
    AgentRuntime,
    blockRun,
    createDeterministicProvider,
    createMission,
    listRunsForMission,
    materializeMission,
    openLocalSessionEventStore,
    readRun,
    settleMissionRunSessionOwner,
    startRun,
    WorkflowRegistry,
} from '@mission-control/core';
import type { GraphCheckpoint, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
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
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_resume';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
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
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_resume_failure';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
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

    it('recovers the same workflow graph after interrupt cold continue without cancelled→running', async () => {
        // Given: a cancelled workflow Run with a durable interrupt checkpoint in session events.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-interrupt-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_interrupt_continue';
        const ownerRunId = 'owner_interrupt_continue';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const prior = await startRun(location, mission.id, 'interrupt me', { sessionId });
        await settleMissionRunSessionOwner(
            location,
            prior.id,
            { sessionId, sessionRunId: ownerRunId },
            { status: 'cancelled', reason: 'operator interrupt' },
        );
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendInterruptedOwnerRun(
            sessionStore,
            sessionId,
            ownerRunId,
            interruptCheckpoint(spec.graph.id, ownerRunId),
        );
        resumeCodingAgentTurnMock.mockImplementation(async (options) => {
            options.observeStoredEvent?.({
                type: 'run.started',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_continue_attempt', state: 'running' },
            });
            options.observeStoredEvent?.({
                type: 'run.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_continue_attempt', state: 'completed' },
            });
            options.emitEvent({
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                taskId: options.turnId,
                run: { runId: 'owner_continue_attempt', state: 'completed' },
            });
            return fakeActiveTurn();
        });

        // When: /continue runs after a cold attach.
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
                nextTurnId: () => 'turn_workflow_interrupt_continue',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([changedWorkflowSpec()]),
            },
        );
        await result.activeTurn?.done;

        // Then: resume injects the original workflow graph and books a new Run.
        expect(resumeCodingAgentTurnMock).toHaveBeenCalledWith(expect.objectContaining({ graph: spec.graph }));
        expect((await readRun(location, prior.id)).status).toBe('cancelled');
        const runs = await listRunsForMission(location, mission.id);
        expect(runs).toHaveLength(2);
        const continueRun = runs.find((run) => run.id !== prior.id);
        expect(continueRun?.status).toBe('completed');
        expect(continueRun?.sessionId).toBe(sessionId);
    });

    it('writes approval hint and resumes without looping after a completed tip', async () => {
        // Given: a blocked owner run that /continue can resume once.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-approval-hint-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_approval_hint';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const running = await startRun(location, mission.id, 'resume me', { sessionId });
        await blockRun(location, running.id, { sessionId, sessionRunId: 'owner_approval_hint' });
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendBlockedOwnerRun(sessionStore, sessionId, 'owner_approval_hint');
        const writes: string[] = [];
        resumeCodingAgentTurnMock.mockImplementation(async (options) => {
            options.observeStoredEvent?.({
                type: 'run.started',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_approval_hint', state: 'running' },
            });
            options.observeStoredEvent?.({
                type: 'run.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                run: { runId: 'owner_approval_hint', state: 'completed' },
            });
            options.emitEvent({
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                sessionId,
                taskId: options.turnId,
                run: { runId: 'owner_approval_hint', state: 'completed' },
            });
            return fakeActiveTurn();
        });

        // When: /continue runs once, then again after the tip is completed.
        const first = await runChatAction(
            new AgentRuntime(),
            { write: (chunk) => writes.push(chunk) },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            {
                activeTurn: undefined,
                useTui: false,
                commandExecutor: undefined,
                emitEvent: undefined,
                nextTurnId: () => 'turn_approval_hint_1',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([spec]),
            },
        );
        await first.activeTurn?.done;
        expect(resumeCodingAgentTurnMock).toHaveBeenCalledTimes(1);
        await sessionStore.append({
            type: 'run.completed',
            timestamp: new Date().toISOString(),
            sessionId,
            run: { runId: 'owner_approval_hint', state: 'completed' },
        });
        resumeCodingAgentTurnMock.mockClear();
        const secondWrites: string[] = [];
        const second = await runChatAction(
            new AgentRuntime(),
            { write: (chunk) => secondWrites.push(chunk) },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            {
                activeTurn: undefined,
                useTui: false,
                commandExecutor: undefined,
                emitEvent: undefined,
                nextTurnId: () => 'turn_approval_hint_2',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([spec]),
            },
        );

        // Then: first continue shows approval hint and resumes; second does not loop.
        expect(writes.join('')).toContain('Resuming run for session_workflow_approval_hint');
        expect(writes.join('')).toContain('blocked on approval');
        expect(resumeCodingAgentTurnMock).not.toHaveBeenCalled();
        expect(second.activeTurn).toBeUndefined();
        expect(secondWrites.join('')).toContain('Nothing to resume');
        expect((await readRun(location, running.id)).status).toBe('completed');
    });

    it('writes interrupt node hint on cold continue and refuses interrupt without checkpoint', async () => {
        // Given: interrupt+checkpoint cold session, then a bare interrupt session.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-interrupt-hint-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_interrupt_hint';
        const ownerRunId = 'owner_interrupt_hint';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const prior = await startRun(location, mission.id, 'interrupt me', { sessionId });
        await settleMissionRunSessionOwner(
            location,
            prior.id,
            { sessionId, sessionRunId: ownerRunId },
            { status: 'cancelled', reason: 'operator interrupt' },
        );
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendInterruptedOwnerRun(
            sessionStore,
            sessionId,
            ownerRunId,
            interruptCheckpoint(spec.graph.id, ownerRunId),
        );
        const writes: string[] = [];
        resumeCodingAgentTurnMock.mockImplementation(async () => fakeActiveTurn());

        // When: /continue on interrupt+checkpoint.
        const result = await runChatAction(
            new AgentRuntime(),
            { write: (chunk) => writes.push(chunk) },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            {
                activeTurn: undefined,
                useTui: false,
                commandExecutor: undefined,
                emitEvent: undefined,
                nextTurnId: () => 'turn_interrupt_hint',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([changedWorkflowSpec()]),
            },
        );
        await result.activeTurn?.done;

        // Then: node hint is written and resume is invoked once.
        expect(writes.join('')).toContain('Resuming interrupted run for session_workflow_interrupt_hint');
        expect(writes.join('')).toContain('queued node(s): entry');
        expect(resumeCodingAgentTurnMock).toHaveBeenCalledTimes(1);

        // And: interrupt without checkpoint refuses resume.
        const bareSessionId = 'session_workflow_interrupt_bare';
        const bareStore = await openLocalSessionEventStore({ dataDir, sessionId: bareSessionId });
        await bareStore.append({
            type: 'run.started',
            timestamp: new Date().toISOString(),
            sessionId: bareSessionId,
            run: { runId: 'owner_bare', state: 'running' },
        });
        await bareStore.append({
            type: 'run.interrupted',
            timestamp: new Date().toISOString(),
            sessionId: bareSessionId,
            run: { runId: 'owner_bare', state: 'interrupted', reason: 'user_interrupt' },
        });
        resumeCodingAgentTurnMock.mockClear();
        const bareWrites: string[] = [];
        const bare = await runChatAction(
            new AgentRuntime(),
            { write: (chunk) => bareWrites.push(chunk) },
            { kind: 'continue' },
            selection,
            async () => undefined,
            [],
            {
                activeTurn: undefined,
                useTui: false,
                commandExecutor: undefined,
                emitEvent: undefined,
                nextTurnId: () => 'turn_interrupt_bare',
                observeStoredEvent: undefined,
                provider: createDeterministicProvider([]),
                sessionId: bareSessionId,
                sessionStore: bareStore,
                workspaceRoot: workspace,
                workflowRegistry: new WorkflowRegistry([spec]),
            },
        );
        expect(bare.activeTurn).toBeUndefined();
        expect(resumeCodingAgentTurnMock).not.toHaveBeenCalled();
        expect(bareWrites.join('')).toContain('interrupted without a graph checkpoint');
    });

    it('does not settle an older workflow Run when a newer plain owner Run is blocked', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'wf-resume-owner-binding-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_workflow_owner_binding';
        const spec = workflowSpec();
        const location = { mcRoot: workspace, dataDir };
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

async function appendInterruptedOwnerRun(
    sessionStore: Awaited<ReturnType<typeof openLocalSessionEventStore>>,
    sessionId: string,
    runId: string,
    checkpoint: GraphCheckpoint,
): Promise<void> {
    const timestamp = new Date().toISOString();
    await sessionStore.append({
        type: 'run.started',
        timestamp,
        sessionId,
        run: { runId, state: 'running' },
    });
    await sessionStore.append({
        type: 'graph.checkpoint',
        timestamp,
        sessionId,
        run: { runId, state: 'running' },
        abg: { graphId: checkpoint.graphId, checkpoint },
    });
    await sessionStore.append({
        type: 'run.interrupted',
        timestamp,
        sessionId,
        // Avoid reason 'operator_aborted' here: observability rewrite can drop runId unless
        // full stop metadata (requestId/operationId) is present.
        run: { runId, state: 'interrupted', reason: 'user_interrupt' },
    });
}

function interruptCheckpoint(graphId: string, sessionRunId: string): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId,
        sessionRunId,
        workflowName: 'resumable-workflow',
        reason: 'interrupt',
        queuedNodeIds: ['entry'],
        completedNodeIds: [],
        nodeStatuses: {},
        attemptsByNodeId: {},
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: 0,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: '2026-07-20T00:00:00.000Z',
    };
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
