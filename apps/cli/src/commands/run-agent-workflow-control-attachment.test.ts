import {
    attachRunSessionOwner,
    blockRun,
    closeProcessSessionControlHosts,
    completeRun,
    createMission,
    getProcessSessionControlHost,
    materializeMission,
    normalizeMissionRunStoreLocation,
    readRun,
    startRun,
    updateRunStatus,
} from '@mission-control/core';
import { WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type NoninteractiveWorkflowRunHandle,
    settleNoninteractiveWorkflowRunWithOwner,
    type WorkflowRunOutcome,
} from './run-agent-workflow-run';
import {
    createWorkflowPersistenceFixture,
    removeWorkflowPersistenceFixture,
    WORKFLOW_PERSISTENCE_SPEC,
    type WorkflowPersistenceFixture,
} from './run-agent-workflow-test-support';

const TERMINAL_OUTCOMES = [
    { status: 'completed' },
    { status: 'failed', reason: 'owner failed' },
    { status: 'cancelled', reason: 'owner cancelled' },
] as const satisfies readonly WorkflowRunOutcome[];

describe('noninteractive workflow SessionControlHost attachment settlement', () => {
    let fixture: WorkflowPersistenceFixture;

    beforeEach(async () => {
        fixture = await createWorkflowPersistenceFixture();
        vi.stubEnv('MCTRL_CONFIG_DIR', fixture.configDir);
        vi.stubEnv('MCTRL_DATA_DIR', fixture.dataDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await closeProcessSessionControlHosts();
        await removeWorkflowPersistenceFixture(fixture);
    });

    it.each(TERMINAL_OUTCOMES)('releases the host attachment after $status owner settlement', async (outcome) => {
        const owned = await createOwnedRun(fixture, `session_control_${outcome.status}`);

        await settleNoninteractiveWorkflowRunWithOwner(owned.handle, outcome, owned.attachment);

        expect(await readRun(owned.handle.location, owned.handle.runId)).toMatchObject({
            status: outcome.status,
            sessionRunId: owned.attachment.sessionRunId,
        });
        expect(owned.host.classify(owned.attachment.sessionId)).toEqual({ kind: 'absent' });
    });

    it('retains the host attachment after blocked owner settlement', async () => {
        const owned = await createOwnedRun(fixture, 'session_control_blocked');

        await blockRun(owned.handle.location, owned.handle.runId, owned.attachment);

        expect(await readRun(owned.handle.location, owned.handle.runId)).toMatchObject({
            status: 'blocked',
            sessionRunId: owned.attachment.sessionRunId,
        });
        expect(owned.host.classify(owned.attachment.sessionId)).toMatchObject({ kind: 'owned' });
    });

    it('retains the running Run and host attachment when owner fencing rejects settlement', async () => {
        const owned = await createOwnedRun(fixture, 'session_control_mismatch');
        await attachRunSessionOwner(owned.handle.location, owned.handle.runId, {
            sessionId: owned.attachment.sessionId,
            sessionRunId: 'owner_original',
        });

        await expect(
            settleNoninteractiveWorkflowRunWithOwner(owned.handle, { status: 'completed' }, owned.attachment),
        ).rejects.toMatchObject({ code: 'run_session_owner_mismatch' });

        expect(await readRun(owned.handle.location, owned.handle.runId)).toMatchObject({
            status: 'running',
            sessionRunId: 'owner_original',
        });
        expect(owned.host.classify(owned.attachment.sessionId)).toMatchObject({ kind: 'owned' });
    });

    it('keeps repeated terminal observer settlement idempotent after attachment release', async () => {
        const owned = await createOwnedRun(fixture, 'session_control_repeated');
        await settleNoninteractiveWorkflowRunWithOwner(owned.handle, { status: 'completed' }, owned.attachment);
        const first = await readRun(owned.handle.location, owned.handle.runId);

        await settleNoninteractiveWorkflowRunWithOwner(owned.handle, { status: 'completed' }, owned.attachment);

        expect(await readRun(owned.handle.location, owned.handle.runId)).toEqual(first);
        expect(owned.host.classify(owned.attachment.sessionId)).toEqual({ kind: 'absent' });
    });

    it('retains the host attachment when a terminal service transition is rejected', async () => {
        const owned = await createOwnedRun(fixture, 'session_control_rejected_transition');
        await blockRun(owned.handle.location, owned.handle.runId, owned.attachment);

        await expect(completeRun(owned.handle.location, owned.handle.runId)).rejects.toMatchObject({
            fromStatus: 'blocked',
            toStatus: 'completed',
        });

        expect(owned.host.classify(owned.attachment.sessionId)).toMatchObject({ kind: 'owned' });
    });

    it('retains blocked ownership through continuation and releases it after completion', async () => {
        const owned = await createOwnedRun(fixture, 'session_control_continue');
        await blockRun(owned.handle.location, owned.handle.runId, owned.attachment);

        await updateRunStatus(owned.handle.location, owned.handle.runId, 'running');
        expect(owned.host.classify(owned.attachment.sessionId)).toMatchObject({ kind: 'owned' });
        await settleNoninteractiveWorkflowRunWithOwner(owned.handle, { status: 'completed' }, owned.attachment);

        expect(await readRun(owned.handle.location, owned.handle.runId)).toMatchObject({
            status: 'completed',
            sessionRunId: owned.attachment.sessionRunId,
        });
        expect(owned.host.classify(owned.attachment.sessionId)).toEqual({ kind: 'absent' });
    });
});

async function createOwnedRun(fixture: WorkflowPersistenceFixture, sessionId: string) {
    const location = normalizeMissionRunStoreLocation({
        omoRoot: fixture.workspaceDir,
        dataDir: fixture.dataDir,
    });
    const mission = materializeMission(WorkflowSpecSchema.parse(WORKFLOW_PERSISTENCE_SPEC));
    await createMission(location, mission);
    const host = await getProcessSessionControlHost(fixture.dataDir);
    const run = await startRun(location, mission.id, 'controlled workflow', { sessionId, sessionControlHost: host });
    const handle: NoninteractiveWorkflowRunHandle = { location, runId: run.id };
    return {
        handle,
        host,
        attachment: { sessionId, sessionRunId: `owner_${sessionId}` },
    } as const;
}
