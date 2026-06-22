import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowGraph, DEFAULT_WORKFLOW_GRAPH_ID } from './default-workflow-graph.js';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/default.workflow.json`;

describe('createDefaultWorkflowGraph', () => {
    it('returns a schema-valid AbgGraphSpec', () => {
        const graph = createDefaultWorkflowGraph();

        const result = AbgGraphSpecSchema.safeParse(graph);

        expect(result.success).toBe(true);
    });

    it('uses "default" as the graph id', () => {
        const graph = createDefaultWorkflowGraph();

        expect(graph.id).toBe(DEFAULT_WORKFLOW_GRAPH_ID);
    });

    it('has intent-gate as the entry node', () => {
        const graph = createDefaultWorkflowGraph();
        const nodeIds = graph.nodes.map((node) => node.id);

        expect(graph.entryNodeId).toBe('intent-gate');
        expect(nodeIds).toContain('intent-gate');
    });

    it('routes from intent-gate to at least 3 distinct targets (trivial, explicit, ambiguous)', () => {
        const graph = createDefaultWorkflowGraph();
        const targets = graph.edges.filter((edge) => edge.source === 'intent-gate').map((edge) => edge.target);
        const uniqueTargets = new Set(targets);

        expect(uniqueTargets.size).toBeGreaterThanOrEqual(3);
        expect(uniqueTargets).toContain('direct-respond');
        expect(uniqueTargets).toContain('memory');
        expect(uniqueTargets).toContain('clarify');
    });

    it('uses llm + parallel + memory node kinds and critic + supervisor implementations', () => {
        const graph = createDefaultWorkflowGraph();
        const kinds = new Set(graph.nodes.map((node) => node.kind));
        const implementations = new Set(
            graph.nodes.map((node) => node.implementation).filter((value): value is string => value !== undefined),
        );

        expect(kinds.has('llm')).toBe(true);
        expect(kinds.has('parallel')).toBe(true);
        expect(kinds.has('memory')).toBe(true);
        expect(implementations.has('critic')).toBe(true);
        expect(implementations.has('supervisor')).toBe(true);
    });

    it('has a delegate-wave parallel node that fans out via task capability', () => {
        const graph = createDefaultWorkflowGraph();
        const delegateWave = graph.nodes.find((node) => node.id === 'delegate-wave');
        const delegateWorker = graph.nodes.find((node) => node.id === 'delegate-worker');

        expect(delegateWave?.kind).toBe('parallel');
        expect(delegateWave?.children).toContain('delegate-worker');
        expect(delegateWorker?.capabilities).toContain('task');
    });

    it('accepts custom model and maxNodeRuns options', () => {
        const graph = createDefaultWorkflowGraph({
            model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
            maxNodeRuns: 12,
        });

        expect(graph.defaults?.model?.providerID).toBe('anthropic');
        expect(graph.defaults?.maxNodeRuns).toBe(12);
    });
});

describe('examples/abg/default.workflow.json', () => {
    it('parses via WorkflowSpecSchema', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');

        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
    });

    it('has name "default" with intent-gate entry node', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.name).toBe('default');
        expect(result.data.graph.entryNodeId).toBe('intent-gate');
    });

    it('produces a graph identical to createDefaultWorkflowGraph()', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.graph).toEqual(createDefaultWorkflowGraph());
    });
});
