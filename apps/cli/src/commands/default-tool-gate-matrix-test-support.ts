import {
    AgentLifecycleManager,
    AsyncJobManager,
    type GoalRuntime,
    RuntimeAgentRegistry,
    type TaskToolRuntimeServices,
} from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { vi } from 'vitest';
import { mcpFixturePath } from './run-agent-tool-registry-test-support';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gateEnabledConfig(): MissionControlConfig {
    return {
        mcp: {
            gate_matrix: {
                type: 'local',
                command: [process.execPath, mcpFixturePath, 'normal'],
                timeoutMs: 5_000,
            },
        },
        browser: { browserURL: 'http://127.0.0.1:9222' },
        memory: { backend: 'local' },
        team_mode: {
            enabled: true,
            maxParallelMembers: 4,
            maxMembers: 8,
            messagePayloadMaxBytes: 32_768,
            recipientUnreadMaxBytes: 262_144,
        },
        monitor: {
            enabled: true,
            liveModeEnabled: false,
            maxMonitorsPerSession: 3,
            maxRuntimeMs: 30_000,
        },
        ssh: { hosts: [{ name: 'prod', host: 'prod.test' }] },
        debug: { enabled: true },
    };
}

export function runtimeServices(): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry();
    return {
        runtimeRegistry,
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        jobManager: new AsyncJobManager(),
    };
}

export const goalRuntime: GoalRuntime = {
    createGoal: ({ objective }) => ({ objective, status: 'active', tokensUsed: 0 }),
    getGoal: () => ({ objective: 'Task 13', status: 'active', tokensUsed: 0 }),
    completeGoal: () => ({ objective: 'Task 13', status: 'complete', tokensUsed: 0 }),
    resumeGoal: () => ({ objective: 'Task 13', status: 'active', tokensUsed: 0 }),
    dropGoal: () => ({ objective: 'Task 13', status: 'active', tokensUsed: 0 }),
};

export async function prepareGateMatrixWorkspace(tempRoots: string[], config: MissionControlConfig): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-task-13-gates-'));
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    const workspaceRoot = join(root, 'workspace');
    await Promise.all([mkdir(configDir), mkdir(dataDir), mkdir(workspaceRoot)]);
    await writeFile(join(configDir, 'config.json'), JSON.stringify(config), 'utf8');
    tempRoots.push(root);
    vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
    vi.stubEnv('MCTRL_DATA_DIR', dataDir);
    for (const key of [
        'EXA_API_KEY',
        'PARALLEL_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'OPENAI_API_KEY',
        'XAI_API_KEY',
    ]) {
        vi.stubEnv(key, '');
    }
    return workspaceRoot;
}
