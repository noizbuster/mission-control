import {
    JsonlSessionEventStore,
    PermissionRuleStore,
    ProjectTrustStore,
    type SdkModelResolver,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSequentialProvider, tempRoot } from './compact-command-test-support';
import { disposeAllMissionControlServices } from './mission-control-services';
import { runOwnerPrompt } from './run-agent-owner-prompt';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await disposeAllMissionControlServices();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runOwnerPrompt task services wiring', () => {
    it('registers eval for a trusted workspace on the real owner-prompt path', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-owner-eval-data-');
        const workspaceRoot = await tempRoot(roots, 'mctrl-owner-eval-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');
        const sessionId = 'session_owner_eval_trusted';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });

        try {
            const result = await runOwnerPrompt({
                sessionId,
                store,
                provider: captureSequentialProvider([], []),
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                workspaceRoot,
                prompt: 'inspect trusted tools',
                emitEvent: () => undefined,
                observeStoredEvent: () => undefined,
                createTurnRunner:
                    ({ toolRegistry }) =>
                    async () => {
                        expect(toolRegistry.advertise().map((tool) => tool.name)).toContain('eval');
                        return { status: 'completed' };
                    },
            });
            expect(result.status).toBe('completed');
        } finally {
            await store.close();
        }
    });

    it('wires MissionControlServices into the noninteractive task registry and shared data-dir DB', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-owner-task-data-');
        const workspaceRoot = await tempRoot(roots, 'mctrl-owner-task-workspace-');
        await mkdir(join(workspaceRoot, '.mc'), { recursive: true });
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_owner_task_services';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        await new PermissionRuleStore({ dataDir }).appendRules([
            { permission: 'subagent', pattern: '*', decision: 'always', workspaceRoot },
        ]);
        const resolveSdkModel: SdkModelResolver = () => {
            throw new Error('background child execution is outside this wiring test');
        };

        try {
            await runOwnerPrompt({
                sessionId,
                store,
                provider: captureSequentialProvider([], []),
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                workspaceRoot,
                prompt: 'start background child',
                emitEvent: () => undefined,
                observeStoredEvent: () => undefined,
                resolveSdkModel,
                createTurnRunner:
                    ({ toolRegistry }) =>
                    async () => {
                        const taskTool = toolRegistry.advertise().find((tool) => tool.name === 'task');
                        if (taskTool === undefined) {
                            throw new Error('task tool was not registered');
                        }
                        const settlement = await toolRegistry.invoke({
                            toolCallId: 'task_background_noninteractive',
                            toolName: 'task',
                            advertisedVersion: taskTool.version,
                            argumentsJson: JSON.stringify({
                                category: 'deep',
                                prompt: 'background proof',
                                run_in_background: true,
                            }),
                        });
                        expect(settlement.result.status).toBe('completed');
                        expect(settlement.structuredOutput).toMatchObject({ status: 'running' });
                        return { status: 'completed' };
                    },
            });
        } finally {
            await store.close();
        }

        expect(existsSync(join(dataDir, 'mission-control.db'))).toBe(true);
        expect(existsSync(join(workspaceRoot, 'mission-control.db'))).toBe(false);
    });

    it('degrades without task runtime services when .mc is missing', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-owner-no-mc-data-');
        const workspaceRoot = await tempRoot(roots, 'mctrl-owner-no-mc-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_owner_no_mc';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const emitted: string[] = [];

        try {
            await runOwnerPrompt({
                sessionId,
                store,
                provider: captureSequentialProvider([], []),
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                workspaceRoot,
                prompt: 'complete without mc services',
                emitEvent: (event) => {
                    emitted.push(event.type);
                },
                observeStoredEvent: () => undefined,
                createTurnRunner: () => async () => ({ status: 'completed' }),
            });
        } finally {
            await store.close();
        }

        expect(emitted).toEqual(['task.started', 'task.completed']);
    });

    it('rejects when MissionControlServices creation fails after .mc resolves', async () => {
        const storeDataDir = await tempRoot(roots, 'mctrl-owner-store-data-');
        const workspaceRoot = await tempRoot(roots, 'mctrl-owner-bad-services-workspace-');
        const dataDirFile = join(await tempRoot(roots, 'mctrl-owner-bad-services-data-parent-'), 'not-a-directory');
        await mkdir(join(workspaceRoot, '.mc'), { recursive: true });
        await writeFile(dataDirFile, 'not a directory', 'utf8');
        vi.stubEnv('MCTRL_DATA_DIR', dataDirFile);
        const sessionId = 'session_owner_bad_services';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir: storeDataDir });

        try {
            await expect(
                runOwnerPrompt({
                    sessionId,
                    store,
                    provider: captureSequentialProvider([], []),
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                    workspaceRoot,
                    prompt: 'surface service creation failure',
                    emitEvent: () => undefined,
                    observeStoredEvent: () => undefined,
                    createTurnRunner: () => async () => ({ status: 'completed' }),
                }),
            ).rejects.toThrow();
        } finally {
            await store.close();
        }
    });
});
