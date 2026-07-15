import { AgentRuntime, discoverWorkflows, materializeWorkflow, WorkflowRegistry } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from '../auth-store.js';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { runCodingPromptOnGraph } from './run-agent-graph-prompt.js';
import { createWorkflowLocalProvider } from './workflow-e2e-test-support.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCAL_SELECTION: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const CUSTOM_WORKFLOW_FIXTURE = join(process.cwd(), 'examples', 'abg', 'custom-example.workflow.jsonc');

describe('custom example production workflow execution', () => {
    const tempDirectories: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('executes the shipped JSONC through discovery, materialization, CLI registries, and graph runtime', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-custom-workflow-ws-'));
        const configDir = await mkdtemp(join(tmpdir(), 'mctrl-custom-workflow-config-'));
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-custom-workflow-data-'));
        tempDirectories.push(workspaceRoot, configDir, dataDir);
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const workflowDirectory = join(workspaceRoot, '.mctrl', 'workflows');
        await mkdir(workflowDirectory, { recursive: true });
        await writeFile(
            join(workflowDirectory, 'custom-example.workflow.jsonc'),
            await readFile(CUSTOM_WORKFLOW_FIXTURE, 'utf8'),
            'utf8',
        );
        const discovered = await discoverWorkflows({ workspaceRoot, userConfigDir: configDir });
        const workflow = new WorkflowRegistry(discovered.workflows).lookup('custom-example');
        expect(discovered.diagnostics).toEqual([]);
        expect(workflow).toBeDefined();
        if (workflow === undefined) return;
        const graph = materializeWorkflow(workflow);
        const runtime = new AgentRuntime(
            createCliRuntimeOptions({
                modelProviderSelection: LOCAL_SELECTION,
                provider: createWorkflowLocalProvider(),
                workspaceRoot,
            }),
        );
        await runtime.start();

        // When
        try {
            const prompt = 'Summarize the available project context.';
            const result = await runCodingPromptOnGraph({
                runtime,
                selection: LOCAL_SELECTION,
                prompt,
                workspaceRoot,
                graph,
                authStore: createProviderAuthStore(),
            });

            // Then
            const toolFailed = result.events.find(
                (event) => event.type === 'tool.failed' && event.abg?.nodeId === 'research',
            );
            expect(toolFailed).toBeUndefined();
            expect(result.status).toBe('completed');
            const toolCompletedIndex = result.events.findIndex(
                (event) => event.type === 'tool.completed' && event.abg?.nodeId === 'research',
            );
            const toolCompleted = result.events[toolCompletedIndex];
            expect(toolCompleted?.abg?.emit?.payload).toMatchObject({ toolName: 'repo.list' });
            const readinessIndex = result.events.findIndex(
                (event) => event.abg?.nodeId === 'answer' && event.abg.emit?.type === 'blackboard.set',
            );
            const readiness = result.events[readinessIndex];
            expect(readiness?.abg?.emit?.payload).toEqual({ key: 'answer.ready', value: true });
            const routeIndex = result.events.findIndex(
                (event) => event.type === 'decision.selected' && event.message === 'rule matched: answer-ready',
            );
            const responseIndex = result.events.findIndex(
                (event) => event.abg?.nodeId === 'respond' && event.abg.emit?.type === 'llm.turn.completed',
            );
            const response = result.events[responseIndex];
            expect(response?.abg?.emit?.payload).toMatchObject({ text: `received prompt: ${prompt}` });
            const graphCompletedIndex = result.events.findIndex((event) => event.type === 'graph.completed');
            expect(toolCompletedIndex).toBeGreaterThanOrEqual(0);
            expect(readinessIndex).toBeGreaterThan(toolCompletedIndex);
            expect(routeIndex).toBeGreaterThan(readinessIndex);
            expect(responseIndex).toBeGreaterThan(routeIndex);
            expect(graphCompletedIndex).toBeGreaterThan(responseIndex);
        } finally {
            await runtime.stop();
        }
    });
});
