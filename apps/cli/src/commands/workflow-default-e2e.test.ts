import type { ProviderAdapter } from '@mission-control/core';
import { discoverWorkflows, WorkflowRegistry } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent';
import {
    buildWorkflowArgs,
    createWorkflowLocalProvider,
    type GraphEvent,
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

    it('discovers the production default workflow with intent-gate entry', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });

        expect(result.diagnostics).toEqual([]);
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec?.graph.id).toBe('default');
        expect(spec?.graph.entryNodeId).toBe('intent-gate');
        const gate = spec?.graph.nodes.find((node) => node.id === 'intent-gate');
        expect(gate?.config?.['outputKey']).toBe('intent.classification');
        expect(spec?.modes === undefined || spec.modes.length === 0).toBe(true);
    });

    it('dispatches a plain prompt through the default implementer graph', async () => {
        const output = await runAgent(buildWorkflowArgs('explain how the build works', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'default')).toBe(true);
        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intent-gate')).toBe(
            true,
        );
        expect(blackboardValues(events, 'intent.classification')).toContain('exploratory-research');
        expect(events.some((event) => event.type === 'graph.completed' || event.type === 'task.completed')).toBe(true);
        expect(events.some((event) => event.type === 'graph.failed' || event.type === 'task.failed')).toBe(false);
        for (const nodeId of ['draft-plan', 'approval-gate', 'write-plan', 'delegate-wave']) {
            expect(events.some((event) => event.type === 'node.started' && event.abg?.nodeId === nodeId)).toBe(false);
        }
    });

    it('sticky implement: fix prompts run the implement graph, not plan write-plan', async () => {
        const output = await runAgent(buildWorkflowArgs('implement a tiny change', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'default')).toBe(true);
        expect(events.some((event) => event.type === 'node.started' && event.abg?.nodeId === 'write-plan')).toBe(false);
        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intent-gate')).toBe(
            true,
        );
        expect(blackboardValues(events, 'intent.classification')).toContain('explicit-implementation');
    }, 30_000);

    it('runs the intent-gate entry node', async () => {
        const output = await runAgent(buildWorkflowArgs('hello', 'json'), { provider, workspaceRoot: workspaceDir });
        const events = parseWorkflowJsonEvents(output);

        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intent-gate')).toBe(
            true,
        );
    });

    it('carries the implementer nodes', async () => {
        const result = await discoverWorkflows({ workspaceRoot: workspaceDir, userConfigDir: configDir });
        const spec = new WorkflowRegistry(result.workflows).lookup('default');
        expect(spec).toBeDefined();
        if (spec === undefined) return;

        const nodeIds = new Set(spec.graph.nodes.map((node) => node.id));
        for (const nodeId of [
            'intent-gate',
            'direct-respond',
            'research-explore',
            'route-planner',
            'todo-plan',
            'delegate-wave',
            'final-respond',
        ]) {
            expect(nodeIds.has(nodeId)).toBe(true);
        }
    });
});

function blackboardValues(events: readonly GraphEvent[], key: string): readonly unknown[] {
    return events.flatMap((event) => {
        const emit = event.abg?.emit;
        return emit?.type === 'blackboard.set' && emit.payload?.key === key ? [emit.payload.value] : [];
    });
}
