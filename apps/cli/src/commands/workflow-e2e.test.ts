/**
 * Workflow dispatch E2E tests (Task 2.9 — Phase 2 integration).
 *
 * Verifies the full path: workflow file discovery -> `#name` parsing -> registry resolution ->
 * graph dispatch through `runAgent`, plus direct `discoverWorkflows` + `WorkflowRegistry` coverage.
 * Uses the deterministic `local/local-echo` provider (injected as `options.provider`) so no real
 * API calls are made — the flat provider is bridged via `wrapFlatProviderAsSdkModel`.
 */
import type { ProviderAdapter } from '@mission-control/core';
import { discoverWorkflows, WorkflowRegistry } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { createCliProviderForSelection, runAgent } from './run-agent.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCAL_SELECTION: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

const TEST_WORKFLOW_SPEC = {
    name: 'test',
    description: 'E2E test workflow',
    graph: {
        id: 'test-e2e-graph',
        version: '0.1.0',
        entryNodeId: 'test-entry',
        defaults: {
            model: { providerID: 'local', modelID: 'local-echo' },
            maxNodeRuns: 8,
        },
        nodes: [{ id: 'test-entry', kind: 'llm', label: 'Test entry' }],
        edges: [{ source: 'test-entry', target: 'test-entry', condition: 'test-loop', priority: 10 }],
        rules: [{ id: 'test-loop', when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true } }],
        policies: [],
    },
} as const;

const DEFAULT_WORKFLOW_SPEC = {
    name: 'default',
    description: 'E2E default workflow',
    graph: {
        id: 'default-e2e-graph',
        version: '0.1.0',
        entryNodeId: 'default-entry',
        defaults: {
            model: { providerID: 'local', modelID: 'local-echo' },
            maxNodeRuns: 8,
        },
        nodes: [{ id: 'default-entry', kind: 'llm', label: 'Default entry' }],
        edges: [{ source: 'default-entry', target: 'default-entry', condition: 'default-loop', priority: 10 }],
        rules: [
            {
                id: 'default-loop',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
        ],
        policies: [],
    },
} as const;

type GraphEvent = {
    readonly type: string;
    readonly abg?: {
        readonly graphId?: string;
        readonly nodeId?: string;
        readonly nodeKind?: string;
    };
};

function parseJsonEvents(output: string): readonly GraphEvent[] {
    return output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as GraphEvent);
}

function createLocalProvider(): ProviderAdapter {
    return createCliProviderForSelection(LOCAL_SELECTION, createProviderAuthStore());
}

async function createE2eWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-wf-e2e-ws-'));
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'test.workflow.json'), JSON.stringify(TEST_WORKFLOW_SPEC), 'utf8');
    await writeFile(join(workflowsDir, 'default.workflow.json'), JSON.stringify(DEFAULT_WORKFLOW_SPEC), 'utf8');
    return dir;
}

function buildArgs(prompt: string, mode: CliArgs['mode']): CliArgs {
    return {
        mode,
        useNative: false,
        command: 'run',
        showHelp: false,
        showVersion: false,
        prompt,
        modelProviderSelection: LOCAL_SELECTION,
    };
}

describe('workflow dispatch end-to-end', () => {
    let workspaceDir: string;
    let configDir: string;
    let provider: ProviderAdapter;

    beforeEach(async () => {
        workspaceDir = await createE2eWorkspace();
        configDir = await mkdtemp(join(tmpdir(), 'mctrl-wf-e2e-cfg-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        provider = createLocalProvider();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(workspaceDir, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
    });

    it('discovers a custom workflow and dispatches its graph via #name', async () => {
        const output = await runAgent(buildArgs('#test hello', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseJsonEvents(output);

        expect(events.some((e) => e.type === 'graph.started' && e.abg?.graphId === 'test-e2e-graph')).toBe(true);
        expect(events.some((e) => e.type === 'graph.completed')).toBe(true);
        expect(events.some((e) => e.type === 'model.call.started' && e.abg?.nodeId === 'test-entry')).toBe(true);
        expect(events.some((e) => e.type === 'task.completed')).toBe(true);
    });

    it('rejects an unknown workflow name with available workflows listed', async () => {
        await expect(
            runAgent(buildArgs('#nonexistent do something', 'plain'), {
                provider,
                workspaceRoot: workspaceDir,
            }),
        ).rejects.toThrow('Unknown workflow "nonexistent"');
    });

    it('resolves #default to a discovered default workflow', async () => {
        const output = await runAgent(buildArgs('#default hello', 'plain'), {
            provider,
            workspaceRoot: workspaceDir,
        });

        expect(output).toContain('graph=default-e2e-graph');
        expect(output).toContain('node=default-entry mode=llm');
    });

    it('falls back to the coding-agent graph when no # prefix is present', async () => {
        const output = await runAgent(buildArgs('just a regular prompt', 'plain'), {
            provider,
            workspaceRoot: workspaceDir,
        });

        expect(output).not.toContain('test-e2e-graph');
        expect(output).not.toContain('default-e2e-graph');
        expect(output).toContain('graph.completed');
    });

    it('discovers workflow files via discoverWorkflows and resolves via WorkflowRegistry', async () => {
        const result = await discoverWorkflows({
            workspaceRoot: workspaceDir,
            userConfigDir: configDir,
        });

        expect(result.diagnostics).toEqual([]);
        const registry = new WorkflowRegistry(result.workflows);
        expect(registry.lookup('test')?.graph.id).toBe('test-e2e-graph');
        expect(registry.lookup('default')?.graph.id).toBe('default-e2e-graph');
        expect(registry.lookup('nonexistent')).toBeUndefined();
        expect(registry.names()).toContain('test');
        expect(registry.names()).toContain('default');
    });
});
