import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createRunnerWorkflowGraph, RUNNER_WORKFLOW_GRAPH_ID } from './runner-workflow-graph.js';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/runner.workflow.json`;

describe('createRunnerWorkflowGraph', () => {
    it('returns a schema-valid AbgGraphSpec', () => {
        const graph = createRunnerWorkflowGraph();

        const result = AbgGraphSpecSchema.safeParse(graph);

        expect(result.success).toBe(true);
    });

    it('uses "runner" as the graph id', () => {
        const graph = createRunnerWorkflowGraph();

        expect(graph.id).toBe(RUNNER_WORKFLOW_GRAPH_ID);
    });

    it('has parse-plan as the entry node', () => {
        const graph = createRunnerWorkflowGraph();
        const nodeIds = graph.nodes.map((node) => node.id);

        expect(graph.entryNodeId).toBe('parse-plan');
        expect(nodeIds).toContain('parse-plan');
    });

    it('has a delegate-wave phase that fans out via task capability', () => {
        const graph = createRunnerWorkflowGraph();
        const delegateWave = graph.nodes.find((node) => node.id === 'delegate-wave');
        const delegateWorker = graph.nodes.find((node) => node.id === 'delegate-worker');

        expect(delegateWave?.kind).toBe('parallel');
        expect(delegateWave?.children).toContain('delegate-worker');
        expect(delegateWorker?.capabilities).toContain('task');
    });

    it('has a per-task-verify phase using critic implementation', () => {
        const graph = createRunnerWorkflowGraph();
        const perTaskVerify = graph.nodes.find((node) => node.id === 'per-task-verify');

        expect(perTaskVerify?.kind).toBe('llm');
        expect(perTaskVerify?.implementation).toBe('critic');
    });

    it('has a final-verification-wave with four parallel critic nodes (f1-f4)', () => {
        const graph = createRunnerWorkflowGraph();
        const finalWave = graph.nodes.find((node) => node.id === 'final-verification-wave');
        const criticIds = ['f1', 'f2', 'f3', 'f4'];

        expect(finalWave?.kind).toBe('parallel');
        expect(finalWave?.children).toEqual(criticIds);

        for (const criticId of criticIds) {
            const critic = graph.nodes.find((node) => node.id === criticId);
            expect(critic?.kind).toBe('llm');
            expect(critic?.implementation).toBe('critic');
        }
    });

    it('routes from final-verification-wave to complete (approved) and fix-loop (rejected)', () => {
        const graph = createRunnerWorkflowGraph();
        const finalEdges = graph.edges.filter((edge) => edge.source === 'final-verification-wave');
        const targets = new Set(finalEdges.map((edge) => edge.target));

        expect(targets.has('complete')).toBe(true);
        expect(targets.has('fix-loop')).toBe(true);
    });

    it('loops checkbox-update back to next-wave for the next wave iteration', () => {
        const graph = createRunnerWorkflowGraph();
        const loopEdge = graph.edges.find((edge) => edge.source === 'checkbox-update' && edge.target === 'next-wave');

        expect(loopEdge).toBeDefined();
    });

    it('routes fix-loop back to next-wave to reopen tasks', () => {
        const graph = createRunnerWorkflowGraph();
        const fixEdge = graph.edges.find((edge) => edge.source === 'fix-loop' && edge.target === 'next-wave');

        expect(fixEdge).toBeDefined();
    });

    it('uses llm + parallel node kinds and critic implementation', () => {
        const graph = createRunnerWorkflowGraph();
        const kinds = new Set(graph.nodes.map((node) => node.kind));
        const implementations = new Set(
            graph.nodes.map((node) => node.implementation).filter((value): value is string => value !== undefined),
        );

        expect(kinds.has('llm')).toBe(true);
        expect(kinds.has('parallel')).toBe(true);
        expect(implementations.has('critic')).toBe(true);
    });

    it('keeps the graph bounded between 12 and 18 nodes', () => {
        const graph = createRunnerWorkflowGraph();

        expect(graph.nodes.length).toBeGreaterThanOrEqual(12);
        expect(graph.nodes.length).toBeLessThanOrEqual(18);
    });

    it('accepts custom model and maxNodeRuns options', () => {
        const graph = createRunnerWorkflowGraph({
            model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
            maxNodeRuns: 24,
        });

        expect(graph.defaults?.model?.providerID).toBe('anthropic');
        expect(graph.defaults?.maxNodeRuns).toBe(24);
    });
});

describe('examples/abg/runner.workflow.json', () => {
    it('parses via WorkflowSpecSchema', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');

        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
    });

    it('has name "runner" with parse-plan entry node', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.name).toBe('runner');
        expect(result.data.graph.entryNodeId).toBe('parse-plan');
    });

    it('produces a graph identical to createRunnerWorkflowGraph()', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.graph).toEqual(createRunnerWorkflowGraph());
    });
});
