/**
 * Planner workflow CLI end-to-end (plan Task 7).
 *
 * Drives the full path: planner fixture discovery -> `#planner` parsing ->
 * graph dispatch through `runAgent` with the deterministic local provider, and
 * proves the materialized (executed) graph carries the planner-readonly
 * policies. Also proves sticky plan mode at dispatch time: a "fix this bug
 * now" prompt runs the planner GRAPH, not the coding-agent implementation
 * graph.
 */
import type { ProviderAdapter } from '@mission-control/core';
import { discoverWorkflows, materializeWorkflow, WorkflowRegistry } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { createCliProviderForSelection, runAgent } from './run-agent.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCAL_SELECTION: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const PLANNER_FIXTURE_PATH = `${process.cwd()}/examples/abg/planner.workflow.json`;

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
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as GraphEvent);
}

function createLocalProvider(): ProviderAdapter {
    return createCliProviderForSelection(LOCAL_SELECTION, createProviderAuthStore());
}

async function createPlannerWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-planner-e2e-ws-'));
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    const fixture = await readFile(PLANNER_FIXTURE_PATH, 'utf8');
    await writeFile(join(workflowsDir, 'planner.workflow.json'), fixture, 'utf8');
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

describe('planner workflow CLI end-to-end', () => {
    let workspaceDir: string;
    let configDir: string;
    let provider: ProviderAdapter;

    beforeEach(async () => {
        workspaceDir = await createPlannerWorkspace();
        configDir = await mkdtemp(join(tmpdir(), 'mctrl-planner-e2e-cfg-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        provider = createLocalProvider();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(workspaceDir, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
    });

    it('discovers the planner workflow from .mctrl/workflows/', async () => {
        const result = await discoverWorkflows({
            workspaceRoot: workspaceDir,
            userConfigDir: configDir,
        });

        expect(result.diagnostics).toEqual([]);
        const registry = new WorkflowRegistry(result.workflows);
        expect(registry.lookup('planner')?.graph.id).toBe('planner');
        expect(registry.lookup('planner')?.graph.entryNodeId).toBe('intake');
    });

    it('dispatches #planner and runs the planner graph (graph.started + graph.completed)', async () => {
        const output = await runAgent(buildArgs('#planner add a rate limit to login', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseJsonEvents(output);

        expect(events.some((event) => event.type === 'graph.started' && event.abg?.graphId === 'planner')).toBe(true);
        expect(events.some((event) => event.type === 'graph.completed')).toBe(true);
        expect(events.some((event) => event.type === 'task.completed')).toBe(true);
    });

    it('sticky plan mode: "fix this bug now" still dispatches the planner graph, not an implementation path', async () => {
        const output = await runAgent(buildArgs('#planner fix this bug now', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseJsonEvents(output);

        const started = events.find((event) => event.type === 'graph.started');
        expect(started?.abg?.graphId).toBe('planner');
        expect(events.some((event) => event.type === 'graph.completed')).toBe(true);
    });

    it('the executed planner graph carries planner-readonly write-deny policies via materializeWorkflow', async () => {
        const result = await discoverWorkflows({
            workspaceRoot: workspaceDir,
            userConfigDir: configDir,
        });
        const registry = new WorkflowRegistry(result.workflows);
        const spec = registry.lookup('planner');
        expect(spec).toBeDefined();
        if (spec === undefined) return;

        const executed = materializeWorkflow(spec);
        const writeDeny = executed.policies.find(
            (policy) => policy.capability === 'write' && policy.decision === 'deny',
        );
        expect(writeDeny).toBeDefined();
        const plansAllow = executed.policies.find(
            (policy) =>
                policy.capability === 'write' &&
                policy.decision === 'allow' &&
                policy.reason === 'resource:.omo/plans/**',
        );
        expect(plansAllow).toBeDefined();
        const draftsAllow = executed.policies.find(
            (policy) =>
                policy.capability === 'write' &&
                policy.decision === 'allow' &&
                policy.reason === 'resource:.omo/drafts/**',
        );
        expect(draftsAllow).toBeDefined();
    });

    it('the planner graph runs the intake entry node', async () => {
        const output = await runAgent(buildArgs('#planner plan a refactor', 'json'), {
            provider,
            workspaceRoot: workspaceDir,
        });
        const events = parseJsonEvents(output);

        expect(events.some((event) => event.type === 'model.call.started' && event.abg?.nodeId === 'intake')).toBe(
            true,
        );
    });
});
