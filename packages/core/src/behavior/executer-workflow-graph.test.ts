import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
    aggregateFinalVerdict,
    createExecuterWorkflowGraph,
    EXECUTER_WORKFLOW_GRAPH_ID,
} from './executer-workflow-graph';

describe('createExecuterWorkflowGraph', () => {
    it('returns schema-valid graph with id executer', () => {
        const graph = createExecuterWorkflowGraph();
        expect(AbgGraphSpecSchema.safeParse(graph).success).toBe(true);
        expect(graph.id).toBe(EXECUTER_WORKFLOW_GRAPH_ID);
        expect(graph.id).toBe('executer');
        expect(graph.entryNodeId).toBe('admit-plan');
    });

    it('fixture matches factory', async () => {
        const contents = await readFile(`${process.cwd()}/examples/abg/executer.workflow.json`, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.name).toBe('executer');
        expect(result.data.graph).toEqual(createExecuterWorkflowGraph());
    });

    it('exports aggregateFinalVerdict fail-closed', () => {
        expect(aggregateFinalVerdict(['APPROVE', 'REJECT', 'APPROVE', 'APPROVE'])).toBe('REJECT');
        expect(aggregateFinalVerdict(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE'])).toBe('APPROVE');
    });

    it('prompts use Mission Control executer language without brand names', () => {
        const graph = createExecuterWorkflowGraph();
        const prompts = graph.nodes.map((n) => String(n.config?.['systemPrompt'] ?? '')).join('\n');
        expect(prompts).toMatch(/Mission Control|executer/i);
        expect(prompts).not.toMatch(/Atlas|Sisyphus|OhMyOpenCode|Hephaestus|Prometheus|Metis|Momus/);
    });
});
