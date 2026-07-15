import type { ProviderAdapter } from '@mission-control/core';
import { discoverWorkflows, WorkflowRegistry } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import {
    buildWorkflowArgs,
    createWorkflowLocalProvider,
    PRODUCTION_DEFAULT_WORKFLOW_FIXTURE,
    parseWorkflowJsonEvents,
} from './workflow-e2e-test-support.js';
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

    it('discovers the production default workflow with the 5-class intent-gate entry node', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });

        expect(result.diagnostics).toEqual([]);
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec?.graph.id).toBe('default');
        expect(spec?.graph.entryNodeId).toBe('intent-gate');
        const intentGate = spec?.graph.nodes.find((node) => node.id === 'intent-gate');
        const outputKey = 'outputKey';
        expect(intentGate?.config?.[outputKey]).toBe('intent.classification');
    });

    it('dispatches a plain prompt through the default workflow graph', async () => {
        const output = await runAgent(buildWorkflowArgs('explain how the build works', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'default')).toBe(true);
        expect(events.some((event) => event.type === 'graph.completed')).toBe(true);
        expect(events.some((event) => event.type === 'task.completed')).toBe(true);
    });

    it('completes an implementation prompt without passing the unchecked delegation guard', async () => {
        const output = await runAgent(buildWorkflowArgs('implement a tiny change', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.completed')).toBe(true);
        expect(events.some((event) => event.type === 'task.completed')).toBe(true);
        expect(events.some((event) => event.type === 'node.started' && event.abg?.nodeId === 'delegate-wave')).toBe(
            false,
        );
    });

    it('runs the intent-gate entry node', async () => {
        const output = await runAgent(buildWorkflowArgs('hello', 'json'), { provider, workspaceRoot: workspaceDir });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intent-gate')).toBe(
            true,
        );
    });

    it('carries the new richness nodes', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec).toBeDefined();
        if (spec === undefined) return;

        const nodeIds = new Set(spec.graph.nodes.map((node) => node.id));
        for (const nodeId of [
            'research-explore',
            'route-planner',
            'anti-dup-guard',
            'evidence-check',
            'maturity-check',
        ]) {
            expect(nodeIds.has(nodeId)).toBe(true);
        }
    });
});
