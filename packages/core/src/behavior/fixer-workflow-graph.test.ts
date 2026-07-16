import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createFixerWorkflowGraph, FIXER_WORKFLOW_GRAPH_ID } from './fixer-workflow-graph';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/fixer.workflow.json`;

describe('createFixerWorkflowGraph', () => {
    it('returns a schema-valid AbgGraphSpec', () => {
        const graph = createFixerWorkflowGraph();

        const result = AbgGraphSpecSchema.safeParse(graph);

        expect(result.success).toBe(true);
    });

    it('uses "fixer" as the graph id', () => {
        const graph = createFixerWorkflowGraph();

        expect(graph.id).toBe(FIXER_WORKFLOW_GRAPH_ID);
    });

    it('has intent-gate as the entry node', () => {
        const graph = createFixerWorkflowGraph();
        const nodeIds = graph.nodes.map((node) => node.id);

        expect(graph.entryNodeId).toBe('intent-gate');
        expect(nodeIds).toContain('intent-gate');
    });

    it('routes from intent-gate to at least 3 distinct targets (trivial, explicit, ambiguous)', () => {
        const graph = createFixerWorkflowGraph();
        const targets = graph.edges.filter((edge) => edge.source === 'intent-gate').map((edge) => edge.target);
        const uniqueTargets = new Set(targets);

        expect(uniqueTargets.size).toBeGreaterThanOrEqual(3);
        expect(uniqueTargets).toContain('direct-respond');
        expect(uniqueTargets).toContain('memory');
        expect(uniqueTargets).toContain('clarify');
    });

    it('uses llm + parallel + memory node kinds and critic + supervisor implementations', () => {
        const graph = createFixerWorkflowGraph();
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
        const graph = createFixerWorkflowGraph();
        const delegateWave = graph.nodes.find((node) => node.id === 'delegate-wave');
        const delegateWorker = graph.nodes.find((node) => node.id === 'delegate-worker');

        expect(delegateWave?.kind).toBe('parallel');
        expect(delegateWave?.children).toContain('delegate-worker');
        expect(delegateWorker?.capabilities).toContain('subagent');
    });

    it('accepts custom model and maxNodeRuns options', () => {
        const graph = createFixerWorkflowGraph({
            model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
            maxNodeRuns: 12,
        });

        expect(graph.defaults?.model?.providerID).toBe('anthropic');
        expect(graph.defaults?.maxNodeRuns).toBe(12);
    });
});

describe('examples/abg/fixer.workflow.json', () => {
    it('parses via WorkflowSpecSchema', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');

        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
    });

    it('has name "fixer" with intent-gate entry node', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.name).toBe('fixer');
        expect(result.data.graph.entryNodeId).toBe('intent-gate');
    });

    it('produces a graph identical to createFixerWorkflowGraph()', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.graph).toEqual(createFixerWorkflowGraph());
    });
});
