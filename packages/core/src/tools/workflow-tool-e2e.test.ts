/**
 * Workflow tool E2E integration test (plan Task 3.13).
 *
 * Exercises the FULL workflow tool resolution path through a real ToolRegistry:
 *   1. Load real planner + runner WorkflowSpecs from `examples/abg/*.workflow.json`.
 *   2. Register them on a WorkflowRegistry (the discovery surface, Task 3.11).
 *   3. Build the workflow tool from that registry and register it on a ToolRegistry.
 *   4. Invoke the tool THROUGH the registry (version check, JSON parse, schema validation,
 *      output bounding — the full settlement path, not a direct execute() call).
 *   5. Verify `started` for known workflows and `not_found` for unknown names.
 *
 * This crosses workflow discovery (JSON parsing), registry construction, tool registration,
 * and the real tool invocation pipeline — none of which the unit tests exercise together.
 */
import { WorkflowSpecSchema, type WorkflowSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ToolRegistry } from './tool-registry.js';
import { WorkflowRegistry } from '../workflows/workflow-registry.js';
import { createWorkflowToolRegistration } from './workflow-tool/workflow-tool.js';

async function loadSpec(filePath: string): Promise<WorkflowSpec> {
    const contents = await readFile(filePath, 'utf8');
    const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
    if (!result.success) {
        throw new Error(`${filePath} failed schema validation: ${result.error.message}`);
    }
    return result.data;
}

async function buildRegistryWithWorkflowTool(): Promise<{
    readonly toolRegistry: ToolRegistry;
    readonly workflowNames: readonly string[];
}> {
    const plannerSpec = await loadSpec(`${process.cwd()}/examples/abg/planner.workflow.json`);
    const runnerSpec = await loadSpec(`${process.cwd()}/examples/abg/runner.workflow.json`);
    const workflowRegistry = new WorkflowRegistry([plannerSpec, runnerSpec]);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createWorkflowToolRegistration({ registry: workflowRegistry }));

    return { toolRegistry, workflowNames: workflowRegistry.names() };
}

describe('workflow tool E2E: registry discovery -> tool registration -> invocation', () => {
    it('registers the workflow tool on a ToolRegistry and advertises it', async () => {
        const { toolRegistry } = await buildRegistryWithWorkflowTool();

        const ads = toolRegistry.advertise();
        const workflowAd = ads.find((ad) => ad.name === 'workflow');

        expect(workflowAd).toBeDefined();
        expect(workflowAd?.capabilityClasses).toContain('workflow');
    });

    it('resolves a known workflow (planner) and returns started through the registry', async () => {
        const { toolRegistry } = await buildRegistryWithWorkflowTool();
        const ad = toolRegistry.advertise().find((advertisement) => advertisement.name === 'workflow');
        expect(ad).toBeDefined();

        const settlement = await toolRegistry.invoke({
            toolCallId: 'tc_e2e_planner',
            toolName: 'workflow',
            advertisedVersion: ad?.version ?? '',
            argumentsJson: JSON.stringify({ name: 'planner', prompt: 'plan the feature' }),
        });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({ status: 'started', workflowName: 'planner' });
    });

    it('resolves a known workflow (runner) and returns started', async () => {
        const { toolRegistry } = await buildRegistryWithWorkflowTool();
        const ad = toolRegistry.advertise().find((advertisement) => advertisement.name === 'workflow');

        const settlement = await toolRegistry.invoke({
            toolCallId: 'tc_e2e_runner',
            toolName: 'workflow',
            advertisedVersion: ad?.version ?? '',
            argumentsJson: JSON.stringify({ name: 'runner', prompt: 'execute the plan' }),
        });

        expect(settlement.structuredOutput).toMatchObject({ status: 'started', workflowName: 'runner' });
    });

    it('returns not_found for an unknown workflow name (model-retryable, no throw)', async () => {
        const { toolRegistry } = await buildRegistryWithWorkflowTool();
        const ad = toolRegistry.advertise().find((advertisement) => advertisement.name === 'workflow');

        const settlement = await toolRegistry.invoke({
            toolCallId: 'tc_e2e_missing',
            toolName: 'workflow',
            advertisedVersion: ad?.version ?? '',
            argumentsJson: JSON.stringify({ name: 'nonexistent-workflow', prompt: 'go' }),
        });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            status: 'not_found',
            workflowName: 'nonexistent-workflow',
        });
        const modelOutput = settlement.modelOutput;
        if (modelOutput === undefined) throw new Error('test setup: no model output');
        expect(modelOutput.content).toContain('planner');
    });

    it('rejects a stale advertised version through the registry version check', async () => {
        const { toolRegistry } = await buildRegistryWithWorkflowTool();

        const settlement = await toolRegistry.invoke({
            toolCallId: 'tc_e2e_stale',
            toolName: 'workflow',
            advertisedVersion: 'stale-version-hash',
            argumentsJson: JSON.stringify({ name: 'planner', prompt: 'go' }),
        });

        expect(settlement.result.status).toBe('failed');
    });
});
