import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    createDefaultWorkflowGraph,
    DEFAULT_PLAN_READONLY_MODE_ID,
    DEFAULT_PLAN_READONLY_POLICIES,
    DEFAULT_WORKFLOW_GRAPH_ID,
} from './default-workflow-graph';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/default.workflow.json`;

describe('createDefaultWorkflowGraph', () => {
    it('returns a schema-valid AbgGraphSpec', () => {
        const graph = createDefaultWorkflowGraph();
        expect(AbgGraphSpecSchema.safeParse(graph).success).toBe(true);
    });

    it('uses "default" as the graph id', () => {
        expect(createDefaultWorkflowGraph().id).toBe(DEFAULT_WORKFLOW_GRAPH_ID);
    });

    it('has intake as the entry node (plan-first)', () => {
        const graph = createDefaultWorkflowGraph();
        expect(graph.entryNodeId).toBe('intake');
        expect(graph.nodes.map((node) => node.id)).toContain('intake');
    });

    it('routes ambiguity to clear / unclear / on-the-fence branches', () => {
        const graph = createDefaultWorkflowGraph();
        const targets = new Set(
            graph.edges.filter((edge) => edge.source === 'assess-ambiguity').map((edge) => edge.target),
        );
        expect(targets.has('explore-filter') || targets.has('research') || targets.has('ask-one-question')).toBe(true);
        expect(targets.size).toBeGreaterThanOrEqual(2);
    });

    it('includes draft-plan, review-plan, approval-gate, and write-plan', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        expect(ids.has('draft-plan')).toBe(true);
        expect(ids.has('review-plan')).toBe(true);
        expect(ids.has('approval-gate')).toBe(true);
        expect(ids.has('write-plan')).toBe(true);
    });

    it('does not include implementer-only nodes (intent-gate / delegate-wave)', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        expect(ids.has('intent-gate')).toBe(false);
        expect(ids.has('delegate-wave')).toBe(false);
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
        expect(WorkflowSpecSchema.safeParse(JSON.parse(contents)).success).toBe(true);
    });

    it('has name "default" with intake entry node', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        expect(result.data.name).toBe('default');
        expect(result.data.graph.entryNodeId).toBe('intake');
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

    it('declares the plan-readonly mode with deny-all-writes-except policies', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        const modes = result.data.modes ?? [];
        const readonlyMode = modes.find((mode) => mode.id === DEFAULT_PLAN_READONLY_MODE_ID);
        expect(readonlyMode).toBeDefined();
        expect(readonlyMode?.policies).toEqual([...DEFAULT_PLAN_READONLY_POLICIES]);
    });
});
