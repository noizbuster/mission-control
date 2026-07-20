/**
 * Default workflow parity — intent-gated plain-prompt implementer.
 *
 * Structural proofs that `#default` / plain prompt intent-gates and implements
 * (never forces .mc/plans full scaffolds). Full planning remains `#planner`.
 */
import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createDefaultWorkflowGraph } from './default-workflow-graph';
import { materializeWorkflow } from '../workflows/materialize-workflow';

const workflowJsonPath = `${process.cwd()}/examples/abg/default.workflow.json`;

describe('default workflow parity — intent-gated implementer structure', () => {
    it('produces a schema-valid graph with intent-gate entry', () => {
        const graph = createDefaultWorkflowGraph();
        expect(AbgGraphSpecSchema.safeParse(graph).success).toBe(true);
        expect(graph.entryNodeId).toBe('intent-gate');
        expect(graph.id).toBe('default');
    });

    it('includes implement path nodes (todo + delegate + verify + evidence)', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        for (const id of [
            'intent-gate',
            'direct-respond',
            'research-explore',
            'route-planner',
            'todo-plan',
            'delegate-wave',
            'verify-wave',
            'evidence-check',
            'supervisor',
            'final-respond',
            'clarify',
        ]) {
            expect(ids.has(id)).toBe(true);
        }
    });

    it('has no plan-scaffold nodes', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        expect(ids.has('draft-plan')).toBe(false);
        expect(ids.has('review-plan')).toBe(false);
        expect(ids.has('approval-gate')).toBe(false);
        expect(ids.has('write-plan')).toBe(false);
        expect(ids.has('assess-ambiguity')).toBe(false);
    });

    it('materializeWorkflow with no modes leaves the graph without plan-readonly policies', () => {
        const executed = materializeWorkflow({
            name: 'default',
            graph: createDefaultWorkflowGraph(),
        });
        expect(executed.policies).toEqual([]);
        expect(executed.entryNodeId).toBe('intent-gate');
    });

    it('escalationTarget is final-respond (user-visible), not plan present', () => {
        expect(createDefaultWorkflowGraph().defaults?.escalationTarget).toBe('final-respond');
    });
});

describe('default workflow fixture parity', () => {
    it('matches createDefaultWorkflowGraph() and declares no modes', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        expect(result.data.graph).toEqual(createDefaultWorkflowGraph());
        expect(result.data.modes === undefined || result.data.modes.length === 0).toBe(true);
    });
});

describe('default workflow intent routing matrix', () => {
    function nodeById(id: string) {
        const node = createDefaultWorkflowGraph().nodes.find((candidate) => candidate.id === id);
        if (node === undefined) {
            throw new Error(`missing node ${id}`);
        }
        return node;
    }

    it('locks intent.classification outputEnum labels', () => {
        const gate = nodeById('intent-gate');
        expect(gate.config?.['outputKey']).toBe('intent.classification');
        expect(gate.config?.['outputEnum']).toEqual([
            'trivial',
            'exploratory-research',
            'open-ended-planning',
            'explicit-implementation',
            'ambiguous',
        ]);
    });

    it('routes intent-gate to five class targets', () => {
        const targets = new Set(
            createDefaultWorkflowGraph()
                .edges.filter((edge) => edge.source === 'intent-gate' && edge.target !== 'intent-gate')
                .map((edge) => edge.target),
        );
        expect(targets.has('direct-respond')).toBe(true);
        expect(targets.has('research-explore')).toBe(true);
        expect(targets.has('route-planner')).toBe(true);
        expect(targets.has('memory')).toBe(true);
        expect(targets.has('clarify')).toBe(true);
    });
});
