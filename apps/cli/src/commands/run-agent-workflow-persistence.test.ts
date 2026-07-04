/**
 * Noninteractive workflow Mission/Run persistence (Task 3).
 *
 * Asserts that an explicit noninteractive workflow invocation
 * (`mctrl --workflow planner "x"` and the `#planner {x}` form) materializes a
 * Mission and starts a Run under `.omo/{missions,runs}/` before the turn, then
 * transitions the Run to `completed` (success) or `failed` (provider failure)
 * when the turn settles — without changing the plain/JSON output contract, and
 * without persisting anything for a plain (non-workflow) prompt.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { listMissions, listRunsForMission } from '@mission-control/core';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLANNER_WORKFLOW = {
    name: 'persist-demo',
    description: 'Test workflow for noninteractive persistence',
    graph: {
        id: 'persist-demo-graph',
        version: '0.1.0',
        entryNodeId: 'persist-intake',
        defaults: {
            model: { providerID: 'local', modelID: 'local-echo' },
            maxNodeRuns: 10,
        },
        nodes: [{ id: 'persist-intake', kind: 'llm', label: 'Persist intake' }],
        edges: [{ source: 'persist-intake', target: 'persist-intake', condition: 'persist-loop', priority: 10 }],
        rules: [
            {
                id: 'persist-loop',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
        ],
        policies: [],
    },
} as const;

function buildMockUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildMockUsage() },
    ];
}

function createCompletingModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: 'local',
        modelId: 'local-echo',
        doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
    });
}

function createFailingModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: 'local',
        modelId: 'local-echo',
        doStream: async () => {
            throw new Error('provider stream failed');
        },
    });
}

async function createWorkflowWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-wf-persist-ws-'));
    await mkdir(join(dir, '.omo'), { recursive: true });
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'persist-demo.workflow.json'), JSON.stringify(PLANNER_WORKFLOW), 'utf8');
    return dir;
}

function first<T>(items: readonly T[]): T {
    const head = items[0];
    if (head === undefined) {
        throw new Error('expected at least one record');
    }
    return head;
}

describe('noninteractive workflow Mission/Run persistence', () => {
    let workspaceDir: string;
    let configDir: string;

    beforeEach(async () => {
        workspaceDir = await createWorkflowWorkspace();
        configDir = await mkdtemp(join(tmpdir(), 'mctrl-wf-persist-cfg-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(workspaceDir, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
    });

    it('persists a completed Mission and Run for --workflow', async () => {
        const output = await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            thinking: false,
                workflowName: 'persist-demo',
                prompt: 'plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingModel(),
            },
        );

        // T8 streaming gate: plain mode returns '' (blocks streamed to stdout).
        expect(output).toBe('');

        const missions = await listMissions(workspaceDir);
        expect(missions).toHaveLength(1);
        const mission = first(missions);
        expect(mission.workflowName).toBe('persist-demo');
        expect(mission.status).toBe('active');

        const runs = await listRunsForMission(workspaceDir, mission.id);
        expect(runs).toHaveLength(1);
        const run = first(runs);
        expect(run.status).toBe('completed');
        expect(run.missionId).toBe(mission.id);
        expect(run.sessionId).toBeDefined();
    });

    it('records a failed Run when the provider fails', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            thinking: false,
                workflowName: 'persist-demo',
                prompt: 'plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createFailingModel(),
            },
        );

        const missions = await listMissions(workspaceDir);
        expect(missions).toHaveLength(1);
        const mission = first(missions);

        const runs = await listRunsForMission(workspaceDir, mission.id);
        expect(runs).toHaveLength(1);
        const run = first(runs);
        expect(run.status).toBe('failed');
        expect(run.terminalReason).toBeDefined();
    });

    it('persists a completed Mission and Run for the #name invocation form', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            thinking: false,
                prompt: '#persist-demo plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingModel(),
            },
        );

        const missions = await listMissions(workspaceDir);
        expect(missions).toHaveLength(1);
        const mission = first(missions);
        const runs = await listRunsForMission(workspaceDir, mission.id);
        expect(first(runs).status).toBe('completed');
    });

    it('does not persist records for a plain prompt', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            thinking: false,
                prompt: 'just a regular prompt',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingModel(),
            },
        );

        const missions = await listMissions(workspaceDir);
        expect(missions).toHaveLength(0);
    });

    it('runs without persisting when no .omo root resolves', async () => {
        const noOmoDir = await mkdtemp(join(tmpdir(), 'mctrl-wf-no-omo-'));
        const workflowsDir = join(noOmoDir, '.mctrl', 'workflows');
        await mkdir(workflowsDir, { recursive: true });
        await writeFile(join(workflowsDir, 'persist-demo.workflow.json'), JSON.stringify(PLANNER_WORKFLOW), 'utf8');
        try {
            const output = await runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
            thinking: false,
                    workflowName: 'persist-demo',
                    prompt: 'plan the migration',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                {
                    workspaceRoot: noOmoDir,
                    resolveSdkModel: () => createCompletingModel(),
                },
            );

            // T8 streaming gate: plain mode returns '' (blocks streamed to stdout).
            expect(output).toBe('');
            const missions = await listMissions(noOmoDir);
            expect(missions).toHaveLength(0);
        } finally {
            await rm(noOmoDir, { recursive: true, force: true });
        }
    });
});
