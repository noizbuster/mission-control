import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
    createDefaultWorkflowGraph,
    DEFAULT_INTENT_GATE_PROMPT,
    DEFAULT_WORKFLOW_GRAPH_ID,
    DEFAULT_WORKFLOW_MAX_NODE_RUNS,
} from './default-workflow-graph';
import { createFixerWorkflowGraph } from './fixer-workflow-graph';

const workflowJsonPath = `${process.cwd()}/examples/abg/default.workflow.json`;

describe('createDefaultWorkflowGraph', () => {
    it('is schema-valid', () => {
        const graph = createDefaultWorkflowGraph();
        expect(AbgGraphSpecSchema.safeParse(graph).success).toBe(true);
    });

    it('uses the default graph id', () => {
        expect(createDefaultWorkflowGraph().id).toBe(DEFAULT_WORKFLOW_GRAPH_ID);
    });

    it('has intent-gate as the entry node', () => {
        const graph = createDefaultWorkflowGraph();
        expect(graph.entryNodeId).toBe('intent-gate');
    });

    it('shares the fixer implement path node set', () => {
        const defaultIds = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        const fixerIds = new Set(createFixerWorkflowGraph().nodes.map((node) => node.id));
        expect(defaultIds).toEqual(fixerIds);
        expect(defaultIds.has('todo-plan')).toBe(true);
        expect(defaultIds.has('delegate-wave')).toBe(true);
        expect(defaultIds.has('write-plan')).toBe(false);
    });

    it('uses the default intent-gate prompt', () => {
        const gate = createDefaultWorkflowGraph().nodes.find((node) => node.id === 'intent-gate');
        expect(gate?.config?.['systemPrompt']).toBe(DEFAULT_INTENT_GATE_PROMPT);
    });

    it('honors maxNodeRuns override', () => {
        const graph = createDefaultWorkflowGraph({ maxNodeRuns: 42 });
        expect(graph.defaults?.maxNodeRuns).toBe(42);
    });

    it('defaults maxNodeRuns to the shared fixer budget', () => {
        expect(createDefaultWorkflowGraph().defaults?.maxNodeRuns).toBe(DEFAULT_WORKFLOW_MAX_NODE_RUNS);
    });
});

describe('examples/abg/default.workflow.json', () => {
    it('is a valid WorkflowSpec', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
    });

    it('matches createDefaultWorkflowGraph() on the graph', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        expect(result.data.graph).toEqual(createDefaultWorkflowGraph());
        expect(result.data.name).toBe('default');
        expect(result.data.modes === undefined || result.data.modes.length === 0).toBe(true);
    });
});
