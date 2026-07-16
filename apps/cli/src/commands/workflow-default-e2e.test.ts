import type { ProviderAdapter } from '@mission-control/core';
import { discoverWorkflows, WorkflowRegistry } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent';
import {
    buildWorkflowArgs,
    createWorkflowLocalProvider,
    PRODUCTION_DEFAULT_WORKFLOW_FIXTURE,
    parseWorkflowJsonEvents,
} from './workflow-e2e-test-support';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('default workflow production fixture end-to-end', () => {
    let workspaceDir: string;
    let configDir: string;
    let dataDir: string;
    let provider: ProviderAdapter;

    beforeEach(async () => {
        workspaceDir = await mkdtemp(join(tmpdir(), 'mctrl-default-prod-ws-'));
        const workflowsDir = join(workspaceDir, '.mctrl', 'workflows');
        await mkdir(workflowsDir, { recursive: true });
        const fixture = await readFile(PRODUCTION_DEFAULT_WORKFLOW_FIXTURE, 'utf8');
        await writeFile(join(workflowsDir, 'default.workflow.json'), fixture, 'utf8');
        configDir = await mkdtemp(join(tmpdir(), 'mctrl-default-prod-cfg-'));
        dataDir = await mkdtemp(join(tmpdir(), 'mctrl-default-prod-data-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        provider = createWorkflowLocalProvider();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all([
            rm(workspaceDir, { recursive: true, force: true }),
            rm(configDir, { recursive: true, force: true }),
            rm(dataDir, { recursive: true, force: true }),
        ]);
    });

    it('discovers the production default workflow with the plan-first intake entry node', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });

        expect(result.diagnostics).toEqual([]);
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec?.graph.id).toBe('default');
        expect(spec?.graph.entryNodeId).toBe('intake');
        const intake = spec?.graph.nodes.find((node) => node.id === 'intake');
        const outputKey = 'outputKey';
        expect(intake?.config?.[outputKey]).toBe('intake.complete');
        const modes = spec?.modes ?? [];
        expect(modes.some((mode) => mode.id === 'plan-readonly')).toBe(true);
    });

    it('dispatches a plain prompt through the default plan-first graph', async () => {
        const output = await runAgent(buildWorkflowArgs('explain how the build works', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'default')).toBe(true);
        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intake')).toBe(
            true,
        );
        // Offline local may terminate via graph.failed when draft-plan hits write-deny
        // node capability policy after plan-readonly materialization.
        expect(
            events.some(
                (event) =>
                    event.type === 'graph.completed' ||
                    event.type === 'graph.failed' ||
                    event.type === 'task.completed' ||
                    event.type === 'run.blocked',
            ),
        ).toBe(true);
    });

    it('sticky plan mode: implement prompts still run the plan graph, not delegate-wave', async () => {
        const output = await runAgent(buildWorkflowArgs('implement a tiny change', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'default')).toBe(true);
        expect(events.some((event) => event.type === 'node.started' && event.abg?.nodeId === 'delegate-wave')).toBe(
            false,
        );
        expect(events.some((event) => event.type === 'node.started' && event.abg?.nodeId === 'intent-gate')).toBe(
            false,
        );
        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intake')).toBe(
            true,
        );
    }, 30_000);

    it('runs the intake entry node', async () => {
        const output = await runAgent(buildWorkflowArgs('hello', 'json'), { provider, workspaceRoot: workspaceDir });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intake')).toBe(
            true,
        );
    });

    it('carries the plan-first nodes', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec).toBeDefined();
        if (spec === undefined) return;

        const nodeIds = new Set(spec.graph.nodes.map((node) => node.id));
        for (const nodeId of [
            'intake',
            'assess-ambiguity',
            'explore-filter',
            'draft-plan',
            'approval-gate',
            'write-plan',
            'present',
        ]) {
            expect(nodeIds.has(nodeId)).toBe(true);
        }
    });
});
