import {
    createDeterministicProvider,
    listMissions,
    listRunsForMission,
    openLocalSessionEventStore,
    readLocalSessionReplay,
} from '@mission-control/core';
import type { AgentEvent, ApprovalRecord } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { disposeAllMissionControlServices } from './mission-control-services';
import { runAgent } from './run-agent';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { writeToolWorkflow } from './run-agent-json-approval-test-support';
import {
    createCompletingWorkflowModel,
    createWorkflowPersistenceFixture,
    firstRecord,
    removeWorkflowPersistenceFixture,
    type WorkflowPersistenceFixture,
} from './run-agent-workflow-test-support';

describe('noninteractive blocked workflow owner restart', () => {
    let fixture: WorkflowPersistenceFixture;

    beforeEach(async () => {
        fixture = await createWorkflowPersistenceFixture();
        vi.stubEnv('MCTRL_CONFIG_DIR', fixture.configDir);
        vi.stubEnv('MCTRL_DATA_DIR', fixture.dataDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await disposeAllMissionControlServices();
        await removeWorkflowPersistenceFixture(fixture);
    });

    it('reattaches exactly the blocked noninteractive owner after stores and runtime restart', async () => {
        const sessionId = 'session_owner_restart';
        const workflowName = 'owner-restart';
        await writeToolWorkflow(fixture.workspaceDir, workflowName);
        await runAgent(parseArgs(['run', `#${workflowName} block`, '--jsonl', '--session', sessionId]), {
            workspaceRoot: fixture.workspaceDir,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'owner_restart_patch',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({ patch: addFilePatch('.owner-restart.txt', 'blocked') }),
                },
                { kind: 'response_completed', content: 'approval required' },
            ]),
        });
        const blockedEvents = await sessionEvents(fixture.dataDir, sessionId);
        const blockedOwnerRunId = eventRunId(blockedEvents, 'run.blocked');
        await appendExternalApproval(fixture.dataDir, sessionId, blockedEvents);
        await disposeAllMissionControlServices();

        const chatOutput = createBufferedChatOutput();
        await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            workspaceRoot: fixture.workspaceDir,
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/continue' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
            resolveSdkModel: () => createCompletingWorkflowModel(),
        });

        const location = { omoRoot: fixture.workspaceDir, dataDir: fixture.dataDir };
        const mission = firstRecord(await listMissions(location));
        const run = firstRecord(await listRunsForMission(location, mission.id));
        expect(chatOutput.getOutput()).toContain(`Resuming run for ${sessionId}`);
        expect(run.status).toBe('completed');
        expect(run.sessionRunId).toBe(blockedOwnerRunId);
    });
});

async function appendExternalApproval(
    dataDir: string,
    sessionId: string,
    events: readonly AgentEvent[],
): Promise<void> {
    const requested = events.find((event) => event.type === 'approval.requested')?.approvalRecord;
    if (requested === undefined) throw new Error('expected pending approval');
    const store = await openLocalSessionEventStore({ dataDir, sessionId });
    try {
        await store.append(approvalUpdated(sessionId, requested));
        await store.append({
            type: 'tool.completed',
            timestamp: new Date().toISOString(),
            sessionId,
            taskId: 'owner_restart_patch',
            message: 'tool completed externally',
            toolResult: { toolCallId: 'owner_restart_patch', status: 'completed', output: 'approved externally' },
        });
    } finally {
        await store.close();
    }
}

function approvalUpdated(sessionId: string, requested: ApprovalRecord): AgentEvent {
    return {
        type: 'approval.updated',
        timestamp: new Date().toISOString(),
        sessionId,
        message: 'approval updated: approved',
        approvalRecord: {
            ...requested,
            state: 'approved',
            decidedAt: new Date().toISOString(),
            reason: 'approved externally',
        },
    };
}

async function sessionEvents(dataDir: string, sessionId: string): Promise<readonly AgentEvent[]> {
    const replay = await readLocalSessionReplay({ dataDir, sessionId });
    if (replay.kind === 'missing') throw new Error(`expected durable session ${sessionId}`);
    return replay.replay.projection.events;
}

function eventRunId(events: readonly AgentEvent[], type: AgentEvent['type']): string {
    const runId = events.find((event) => event.type === type)?.run?.runId;
    if (runId === undefined) throw new Error(`expected ${type} run id`);
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
