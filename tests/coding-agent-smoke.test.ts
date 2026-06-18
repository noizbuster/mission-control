import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { runAgent } from '../apps/cli/src/commands/run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from '../apps/cli/src/commands/run-agent-chat-test-support.js';
import { runSessionCommand } from '../apps/cli/src/commands/session.js';
import {
    JsonlSessionEventStore,
    missionControlDataDirEnvKey,
    type ProviderTurnRequest,
} from '../packages/core/src/index.js';
import {
    approvePendingSmokePatch,
    expectBlockedSmokeRunArtifacts,
    expectResumedSmokeRunArtifacts,
    fakeBashExecutor,
    initializeTrustedSmokeWorkspace,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
    scriptedCodingSmokeProvider,
    sessionStartedEvent,
} from './coding-agent-smoke-test-support.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('coding-agent end-to-end smoke', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('proves trusted read edit write bash block resume and durable replay from a temp workspace', async () => {
        const dataDir = await tempRoot('mctrl-smoke-data-');
        const workspaceRoot = await tempRoot('mctrl-smoke-workspace-');
        const sessionId = 'session_smoke_coding_agent';
        const workspaceNestedRoot = join(workspaceRoot, 'nested');
        const sessionJsonlPath = join(dataDir, 'sessions', `${sessionId}.jsonl`);
        const providerRequests: ProviderTurnRequest[] = [];

        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        await initializeTrustedSmokeWorkspace(dataDir, workspaceRoot);

        const provider = scriptedCodingSmokeProvider(providerRequests);
        // `--engine flat`: this e2e proves the FLAT escape-hatch path's resumable-block approval
        // model (a denied/queued patch parks as a pending approval that /resume re-drives). The graph
        // DEFAULT treats a deny as terminal (no resumable block) and regenerates its own tool turns,
        // so the flat-cadence scripted provider + block/resume flow is flat-specific. The graph
        // coding path is covered by the run-agent-interactive-* suite.
        const firstOutput = await runAgent(
            parseArgs(['--session', sessionId, '--model', 'local/local-echo', '--engine', 'flat']),
            {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'inspect, edit, write, verify, then queue one blocked approval' },
                { type: 'line', value: 'always' },
                { type: 'line', value: 'always' },
                { type: 'line', value: 'once' },
                { type: 'line', value: 'deny' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            commandExecutor: async (request) => fakeBashExecutor(request, workspaceNestedRoot),
            provider,
        });

        const blockedReplayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const blockedJsonlContents = await readFile(sessionJsonlPath, 'utf8');

        await approvePendingSmokePatch(dataDir, sessionId, workspaceRoot, 'smoke_patch_call');

        const resumedOutput = await runAgent(
            parseArgs(['--session', sessionId, '--model', 'local/local-echo', '--engine', 'flat']),
            {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/resume' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            commandExecutor: async (request) => fakeBashExecutor(request, workspaceNestedRoot),
            provider,
        });

        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const resumedJsonlContents = await readFile(sessionJsonlPath, 'utf8');

        expectBlockedSmokeRunArtifacts({
            firstOutput,
            workspaceNestedRoot,
            providerRequests,
            blockedReplayOutput,
            blockedJsonlContents,
        });
        await expectResumedSmokeRunArtifacts({
            blockedJsonlContents,
            resumedOutput,
            sessionId,
            workspaceRoot,
            replayOutput,
            resumedJsonlContents,
        });
    });

    it('fails clearly when the blocked smoke patch tool call is missing', async () => {
        const dataDir = await tempRoot('mctrl-smoke-malformed-data-');
        const workspaceRoot = await tempRoot('mctrl-smoke-malformed-workspace-');

        await expect(
            approvePendingSmokePatch(dataDir, 'session_smoke_missing_patch', workspaceRoot, 'missing_patch_call'),
        ).rejects.toThrow('missing tool call for approval_permission_missing_patch_call');
    });

    it('fails when blocked replay lacks the runtime-owned approval.requested event', async () => {
        const dataDir = await tempRoot('mctrl-smoke-missing-approval-data-');
        const workspaceRoot = await tempRoot('mctrl-smoke-missing-approval-workspace-');
        const sessionId = 'session_smoke_missing_runtime_approval';
        const store = await JsonlSessionEventStore.open({ dataDir, sessionId });

        try {
            await store.append(sessionStartedEvent(sessionId));
            await store.append(providerToolCallEvent(sessionId, 'smoke_patch_call'));
            await store.append(permissionRequestedEvent(sessionId, 'smoke_patch_call'));
            await store.append(runBlockedEvent(sessionId, 'smoke_patch_call'));
        } finally {
            await store.close();
        }

        await expect(approvePendingSmokePatch(dataDir, sessionId, workspaceRoot, 'smoke_patch_call')).rejects.toThrow(
            'missing runtime-owned approval.requested for approval_permission_smoke_patch_call',
        );
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});
