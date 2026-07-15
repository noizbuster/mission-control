import { listMissions, readRun } from '@mission-control/core';
import { ABG_GRAPH_STATUSES, type AbgGraphStatus, WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    beginNoninteractiveWorkflowRun,
    settleNoninteractiveWorkflowRun,
    type WorkflowRunOutcome,
    workflowOutcomeFromGraphStatus,
    workflowOutcomeFromOwnerStatus,
} from './run-agent-workflow-run.js';
import {
    createWorkflowPersistenceFixture,
    firstRecord,
    removeWorkflowPersistenceFixture,
    WORKFLOW_PERSISTENCE_SPEC,
    type WorkflowPersistenceFixture,
} from './run-agent-workflow-test-support.js';

const EXPECTED_GRAPH_OUTCOMES = {
    created: { status: 'failed', reason: 'graph settled non-terminally as created' },
    active: { status: 'failed', reason: 'graph settled non-terminally as active' },
    blocked: { status: 'blocked', reason: 'approval required' },
    completed: { status: 'completed' },
    failed: { status: 'failed', reason: 'workflow graph run failed' },
    cancelled: { status: 'cancelled', reason: 'workflow graph run cancelled' },
} satisfies Readonly<Record<AbgGraphStatus, WorkflowRunOutcome>>;

const OWNER_OUTCOMES = [
    { ownerStatus: 'completed', expected: { status: 'completed' } },
    { ownerStatus: 'blocked', expected: { status: 'blocked' } },
    { ownerStatus: 'failed', expected: { status: 'failed', reason: 'workflow turn failed' } },
    { ownerStatus: 'cancelled', expected: { status: 'cancelled', reason: 'workflow turn cancelled' } },
] as const;

describe('noninteractive workflow Run lifecycle', () => {
    let fixture: WorkflowPersistenceFixture;

    beforeEach(async () => {
        fixture = await createWorkflowPersistenceFixture();
        vi.stubEnv('MCTRL_CONFIG_DIR', fixture.configDir);
        vi.stubEnv('MCTRL_DATA_DIR', fixture.dataDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await removeWorkflowPersistenceFixture(fixture);
    });

    it.each(ABG_GRAPH_STATUSES)('maps settled graph status %s without silent success', (status) => {
        expect(workflowOutcomeFromGraphStatus(status, undefined)).toEqual(EXPECTED_GRAPH_OUTCOMES[status]);
    });

    it.each(OWNER_OUTCOMES)('maps owner status $ownerStatus to the persisted outcome', ({ ownerStatus, expected }) => {
        expect(workflowOutcomeFromOwnerStatus(ownerStatus)).toEqual(expected);
    });

    it('carries one normalized project and data location in the workflow handle', async () => {
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
        );

        expect(handle).toMatchObject({ location: { omoRoot: fixture.workspaceDir, dataDir: fixture.dataDir } });
    });

    it('links a Run to the actual session when supplied', async () => {
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
            { sessionId: 'session_noninteractive_actual', prompt: 'preserve this request' },
        );

        if (handle === undefined) throw new Error('expected workflow run handle');
        const mission = firstRecord(await listMissions(handle.location));
        const run = await readRun(handle.location, handle.runId);
        expect(run.missionId).toBe(mission.id);
        expect(run.sessionId).toBe('session_noninteractive_actual');
        expect(run.prompt).toBe('preserve this request');
    });

    it('persists the executed graph so a blocked Run resumes with the same policies', async () => {
        const spec = WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC);
        const executedGraph = { ...spec.graph, id: 'materialized-executed-graph' };
        const handle = await beginNoninteractiveWorkflowRun(fixture.workspaceDir, spec, {
            sessionId: 'session_noninteractive_graph',
            graph: executedGraph,
        });

        if (handle === undefined) throw new Error('expected workflow run handle');
        const mission = firstRecord(await listMissions(handle.location));
        expect(mission.graph).toEqual(executedGraph);
    });

    it('leaves a Run unlinked when no session exists', async () => {
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
        );

        if (handle === undefined) throw new Error('expected workflow run handle');
        expect((await readRun(handle.location, handle.runId)).sessionId).toBeUndefined();
    });

    it('settles an approval-blocked Run as blocked without terminal metadata', async () => {
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
            { sessionId: 'session_noninteractive_blocked' },
        );

        await settleNoninteractiveWorkflowRun(handle, { status: 'blocked', reason: 'approval required' });

        if (handle === undefined) throw new Error('expected workflow run handle');
        const run = await readRun(handle.location, handle.runId);
        expect(run.status).toBe('blocked');
        expect(run.sessionId).toBe('session_noninteractive_blocked');
        expect(run.terminalReason).toBeUndefined();
    });

    it('settles a cancelled workflow Run as cancelled with terminal metadata', async () => {
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
            { sessionId: 'session_noninteractive_cancelled' },
        );

        await settleNoninteractiveWorkflowRun(handle, { status: 'cancelled', reason: 'operator interrupted workflow' });

        if (handle === undefined) throw new Error('expected workflow run handle');
        const run = await readRun(handle.location, handle.runId);
        expect(run.status).toBe('cancelled');
        expect(run.sessionId).toBe('session_noninteractive_cancelled');
        expect(run.terminalReason).toBe('operator interrupted workflow');
        expect(run.endedAt).toBeDefined();
    });

    it.each([
        { status: 'blocked' },
        { status: 'completed' },
        { status: 'failed', reason: 'owner failed' },
        { status: 'cancelled', reason: 'owner cancelled' },
    ] as const)('routes a $status workflow Run with an owner through atomic settlement', async (outcome) => {
        const sessionId = `session_owner_${outcome.status}`;
        const handle = await beginNoninteractiveWorkflowRun(
            fixture.workspaceDir,
            WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC),
            { sessionId },
        );

        await settleNoninteractiveWorkflowRun(handle, outcome, {
            sessionId,
            sessionRunId: `owner_${outcome.status}`,
        });

        if (handle === undefined) throw new Error('expected workflow run handle');
        expect(await readRun(handle.location, handle.runId)).toMatchObject({
            status: outcome.status,
            sessionRunId: `owner_${outcome.status}`,
        });
    });
});
