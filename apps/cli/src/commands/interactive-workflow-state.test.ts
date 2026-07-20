import {
    blockRun,
    createMission,
    listRunsForMission,
    materializeMission,
    readRun,
    settleMissionRunSessionOwner,
    startRun,
    WorkflowRegistry,
} from '@mission-control/core';
import type { GraphCheckpoint, WorkflowSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findWorkflowGraphForSessionContinue } from './interactive-workflow-state';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('findWorkflowGraphForSessionContinue', () => {
    it('returns the mission graph for a cancelled interrupt run and starts a new SQL Run', async () => {
        // Given: a workflow-backed mission whose prior Run was cancelled after interrupt.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-continue-cancelled-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_interrupt_continue';
        const sessionRunId = 'owner_interrupt_continue';
        const spec = workflowSpec('interrupt-workflow', 'interrupt-workflow-graph');
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const prior = await startRun(location, mission.id, 'continue me', { sessionId });
        await settleMissionRunSessionOwner(
            location,
            prior.id,
            { sessionId, sessionRunId },
            { status: 'cancelled', reason: 'operator interrupt' },
        );

        // When: cold continue recovers the workflow graph without requiring blocked status.
        const recovered = await findWorkflowGraphForSessionContinue({
            workspaceRoot: workspace,
            sessionId,
            sessionRunId,
            workflowRegistry: new WorkflowRegistry([changedWorkflowSpec(spec)]),
            prompt: 'continue me',
        });

        // Then: the original mission graph is returned and a new running Run is booked.
        expect(recovered?.graph).toEqual(spec.graph);
        expect(recovered?.bookkeeping).toBe('started_new_run');
        expect(recovered?.handle).toBeDefined();
        const handle = recovered?.handle;
        if (handle === undefined) throw new Error('expected continue handle');
        expect(handle.runId).not.toBe(prior.id);
        expect(handle.missionId).toBe(mission.id);
        expect((await readRun(location, prior.id)).status).toBe('cancelled');
        const next = await readRun(location, handle.runId);
        expect(next.status).toBe('running');
        expect(next.sessionId).toBe(sessionId);
        expect(next.missionId).toBe(mission.id);
        expect(await listRunsForMission(location, mission.id)).toHaveLength(2);
    });

    it('reuses a blocked Run without starting a replacement row', async () => {
        // Given: a blocked workflow Run waiting on approval.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-continue-blocked-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_blocked_continue';
        const sessionRunId = 'owner_blocked_continue';
        const spec = workflowSpec('blocked-workflow', 'blocked-workflow-graph');
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(spec);
        await createMission(location, mission);
        const prior = await startRun(location, mission.id, 'approve me', { sessionId });
        await blockRun(location, prior.id, { sessionId, sessionRunId });

        // When: continue recovers the workflow graph for the blocked owner run.
        const recovered = await findWorkflowGraphForSessionContinue({
            workspaceRoot: workspace,
            sessionId,
            sessionRunId,
            workflowRegistry: new WorkflowRegistry([changedWorkflowSpec(spec)]),
        });

        // Then: the blocked Run is reused and no replacement row is created.
        expect(recovered?.graph).toEqual(spec.graph);
        expect(recovered?.bookkeeping).toBe('reuse_blocked');
        expect(recovered?.handle?.runId).toBe(prior.id);
        expect((await listRunsForMission(location, mission.id)).map((run) => run.id)).toEqual([prior.id]);
        expect((await readRun(location, prior.id)).status).toBe('blocked');
    });

    it('materializes a checkpoint workflowName when no Mission row exists', async () => {
        // Given: no Mission/Run rows, only a checkpoint naming a registered workflow.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-continue-checkpoint-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const spec = workflowSpec('checkpoint-workflow', 'checkpoint-workflow-graph');

        // When: continue recovers from checkpoint metadata alone.
        const recovered = await findWorkflowGraphForSessionContinue({
            workspaceRoot: workspace,
            sessionId: 'session_checkpoint_only',
            sessionRunId: 'owner_checkpoint_only',
            workflowRegistry: new WorkflowRegistry([spec]),
            checkpoint: checkpoint({
                graphId: spec.graph.id,
                sessionRunId: 'owner_checkpoint_only',
                workflowName: spec.name,
            }),
        });

        // Then: the registry graph is returned with no Mission bookkeeping handle.
        expect(recovered?.graph).toEqual(spec.graph);
        expect(recovered?.handle).toBeUndefined();
        expect(recovered?.bookkeeping).toBe('graph_only');
    });

    it('returns undefined for plain coding sessions without workflow linkage', async () => {
        // Given: a workspace with .mc dirs but no mission/run/checkpoint workflow metadata.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-continue-plain-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        // When: continue looks for a workflow graph.
        const recovered = await findWorkflowGraphForSessionContinue({
            workspaceRoot: workspace,
            sessionId: 'session_plain_coding',
            sessionRunId: 'owner_plain_coding',
            workflowRegistry: new WorkflowRegistry([workflowSpec('unused', 'unused-graph')]),
        });

        // Then: plain coding continues without a Mission or workflow graph.
        expect(recovered).toBeUndefined();
    });
});

function workflowSpec(name: string, graphId: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: graphId,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function changedWorkflowSpec(spec: WorkflowSpec): WorkflowSpec {
    return {
        ...spec,
        graph: {
            ...spec.graph,
            id: `${spec.graph.id}-changed`,
        },
    };
}

function checkpoint(input: {
    readonly graphId: string;
    readonly sessionRunId?: string;
    readonly workflowName?: string;
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId,
        ...(input.sessionRunId !== undefined ? { sessionRunId: input.sessionRunId } : {}),
        ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
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
