import {
    attachRunSessionOwner,
    createDeterministicProvider,
    listMissions,
    listRunsForMission,
    readLocalSessionReplay,
    type SessionControlEntityKind,
    type SessionControlHost,
} from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import {
    disposeAllMissionControlServices,
    getOrCreateMissionControlServices,
    MissionControlServices,
} from './mission-control-services';
import { runAgent } from './run-agent';
import { writeToolWorkflow } from './run-agent-json-approval-test-support';
import {
    createCompletingWorkflowModel,
    createWorkflowPersistenceFixture,
    firstRecord,
    removeWorkflowPersistenceFixture,
    type WorkflowPersistenceFixture,
} from './run-agent-workflow-test-support';

describe('noninteractive workflow session owner linkage', () => {
    let fixture: WorkflowPersistenceFixture;

    beforeEach(async () => {
        fixture = await createWorkflowPersistenceFixture();
        vi.stubEnv('MCTRL_CONFIG_DIR', fixture.configDir);
        vi.stubEnv('MCTRL_DATA_DIR', fixture.dataDir);
    });

    afterEach(async () => {
        await disposeAllMissionControlServices();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await removeWorkflowPersistenceFixture(fixture);
    });

    it('persists the completed runOwnerPrompt receipt runId on the Mission Run', async () => {
        const sessionId = 'session_completed_owner_link';

        await runAgent(parseArgs(['run', '#persist-demo complete', '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            resolveSdkModel: () => createCompletingWorkflowModel(),
        });

        const ownerRunId = await durableOwnerRunId(fixture.dataDir, sessionId, 'run.started');
        const run = await persistedWorkflowRun(fixture);
        expect(run.status).toBe('completed');
        expect(run.sessionRunId).toBe(ownerRunId);
    });

    it('attaches the running Mission Run and provider owner to one shared control host', async () => {
        const sessionId = 'session_running_control_link';
        const disposal = observeServiceDisposal(sessionId);
        let sessionControlHost: SessionControlHost | undefined;
        let attachmentKinds: readonly SessionControlEntityKind[] = [];

        await runAgent(parseArgs(['run', '#persist-demo inspect control', '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            resolveSdkModel: () =>
                createCompletingWorkflowModel(async () => {
                    const services = await getOrCreateMissionControlServices(fixture.workspaceDir);
                    const host = services.getSessionControlHost();
                    if (host === undefined) throw new Error('expected MissionControlServices session control host');
                    sessionControlHost = host;
                    attachmentKinds = await snapshotAttachmentKinds(host, sessionId);
                }),
        });

        expect(attachmentKinds).toEqual(expect.arrayContaining(['mission_run', 'run']));
        expect(sessionControlHost?.classify(sessionId)).toEqual({ kind: 'absent' });
        expect(disposal.attachments).toEqual([[]]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });

    it('persists the blocked owner runId needed for exact continuation lookup', async () => {
        const sessionId = 'session_blocked_owner_link';
        const disposal = observeServiceDisposal(sessionId);
        const workflowName = 'blocked-owner-link';
        await writeToolWorkflow(fixture.workspaceDir, workflowName);

        await runAgent(parseArgs(['run', `#${workflowName} block`, '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'blocked_owner_call',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({ patch: addFilePatch('.blocked-owner.txt', 'blocked') }),
                },
                { kind: 'response_completed', content: 'approval required' },
            ]),
        });

        const ownerRunId = await durableOwnerRunId(fixture.dataDir, sessionId, 'run.blocked');
        const run = await persistedWorkflowRun(fixture);
        expect(run.status).toBe('blocked');
        expect(run.sessionRunId).toBe(ownerRunId);
        expect(disposal.attachments).toEqual([['mission_run']]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });

    it('retains the failed owner runId on the terminal Mission Run', async () => {
        const sessionId = 'session_failed_owner_link';
        const disposal = observeServiceDisposal(sessionId);

        await runAgent(parseArgs(['run', '#persist-demo fail', '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: { code: 'unknown', message: 'provider failed', retryable: false },
                },
            ]),
        });

        const ownerRunId = await durableOwnerRunId(fixture.dataDir, sessionId, 'run.failed');
        const run = await persistedWorkflowRun(fixture);
        expect(run.status).toBe('failed');
        expect(run.sessionRunId).toBe(ownerRunId);
        expect(disposal.attachments).toEqual([[]]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });

    it('retains the interrupted owner runId on the cancelled Mission Run', async () => {
        const sessionId = 'session_cancelled_owner_link';
        const disposal = observeServiceDisposal(sessionId);

        await runAgent(parseArgs(['run', '#persist-demo cancel', '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: { code: 'provider_aborted', message: 'provider aborted', retryable: false },
                },
            ]),
        });

        const ownerRunId = await durableOwnerRunId(fixture.dataDir, sessionId, 'run.interrupted');
        const run = await persistedWorkflowRun(fixture);
        expect(run.status).toBe('cancelled');
        expect(run.sessionRunId).toBe(ownerRunId);
        expect(run.endedAt).toBeDefined();
        expect(disposal.attachments).toEqual([[]]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });

    it('settles safely without fabricating an owner when setup fails before a receipt', async () => {
        const sessionId = 'session_owner_setup_failure';
        const disposal = observeServiceDisposal(sessionId);

        await expect(
            runAgent(parseArgs(['run', '#persist-demo fail setup', '--jsonl', '--session', sessionId]), {
                workspaceRoot: fixture.workspaceDir,
                resolveSdkModel: () => {
                    throw new Error('owner model setup failed');
                },
            }),
        ).rejects.toThrow('owner model setup failed');

        const run = await persistedWorkflowRun(fixture);
        expect(run.status).toBe('failed');
        expect(run.sessionRunId).toBeUndefined();
        expect(disposal.attachments).toEqual([[]]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to an unfenced status write when owner settlement is rejected', async () => {
        const sessionId = 'session_owner_settlement_rejected';
        const disposal = observeServiceDisposal(sessionId);

        await expect(
            runAgent(parseArgs(['run', '#persist-demo owner collision', '--jsonl', '--session', sessionId]), {
                workspaceRoot: fixture.workspaceDir,
                resolveSdkModel: () =>
                    createCompletingWorkflowModel(async () => {
                        const run = await persistedWorkflowRun(fixture);
                        await attachRunSessionOwner(
                            { omoRoot: fixture.workspaceDir, dataDir: fixture.dataDir },
                            run.id,
                            { sessionId, sessionRunId: 'owner_conflicting' },
                        );
                    }),
            }),
        ).rejects.toThrow('different session owner');

        expect(await persistedWorkflowRun(fixture)).toMatchObject({
            status: 'running',
            sessionRunId: 'owner_conflicting',
        });
        expect(disposal.attachments).toEqual([['mission_run']]);
        expect(disposal.afterDispose).toEqual(['absent']);
        expect(disposal.spy).toHaveBeenCalledTimes(1);
    });
});

async function persistedWorkflowRun(fixture: WorkflowPersistenceFixture) {
    const location = { omoRoot: fixture.workspaceDir, dataDir: fixture.dataDir };
    const mission = firstRecord(await listMissions(location));
    return firstRecord(await listRunsForMission(location, mission.id));
}

async function durableOwnerRunId(
    dataDir: string,
    sessionId: string,
    eventType: 'run.started' | 'run.blocked' | 'run.failed' | 'run.interrupted',
): Promise<string> {
    const replay = await readLocalSessionReplay({ dataDir, sessionId });
    if (replay.kind === 'missing') throw new Error(`expected durable session ${sessionId}`);
    const runId = replay.replay.projection.events.find((event) => event.type === eventType)?.run?.runId;
    if (runId === undefined) throw new Error(`expected ${eventType} owner receipt`);
    return runId;
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

async function snapshotAttachmentKinds(
    host: SessionControlHost,
    sessionId: string,
): Promise<readonly SessionControlEntityKind[]> {
    const classification = host.classify(sessionId);
    if (classification.kind === 'absent') return [];
    if (classification.kind !== 'owned') {
        throw new Error(`expected owned session control host, received ${classification.kind}`);
    }
    const snapshot = await host.stopSnapshot(sessionId, classification);
    try {
        return snapshot.attachments.map((attachment) => attachment.kind);
    } finally {
        await host.cancelStop(sessionId, classification);
        await snapshot.release();
    }
}

function observeServiceDisposal(sessionId: string) {
    const attachments: Array<readonly SessionControlEntityKind[]> = [];
    const afterDispose: string[] = [];
    const originalDispose = MissionControlServices.prototype.dispose;
    const spy = vi.spyOn(MissionControlServices.prototype, 'dispose').mockImplementation(async function (
        this: MissionControlServices,
    ) {
        const host = this.getSessionControlHost();
        attachments.push(host === undefined ? [] : await snapshotAttachmentKinds(host, sessionId));
        await originalDispose.call(this);
        afterDispose.push(host?.classify(sessionId).kind ?? 'absent');
    });
    return { afterDispose, attachments, spy } as const;
}
