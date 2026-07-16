/**
 * Default workflow parity — plan-first plain-prompt fallback.
 *
 * Structural proofs that `#default` plans (never implements): intake → ambiguity
 * routing → draft/review/approval → write-plan, with sticky plan-readonly mode.
 */
import { AbgGraphSpecSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
    createDefaultWorkflowGraph,
    DEFAULT_PLAN_READONLY_MODE,
    DEFAULT_PLAN_READONLY_POLICIES,
} from './default-workflow-graph';
import { evaluateRules } from '../permissions/rule-evaluator';
import { materializeWorkflow } from '../workflows/materialize-workflow';

const workflowJsonPath = `${process.cwd()}/examples/abg/default.workflow.json`;

describe('default workflow parity — plan-first structure', () => {
    it('produces a schema-valid graph with intake entry', () => {
        const graph = createDefaultWorkflowGraph();
        expect(AbgGraphSpecSchema.safeParse(graph).success).toBe(true);
        expect(graph.entryNodeId).toBe('intake');
        expect(graph.id).toBe('default');
    });

    it('includes draft-plan, review-plan, approval-gate, write-plan', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        for (const id of ['draft-plan', 'review-plan', 'approval-gate', 'write-plan', 'present']) {
            expect(ids.has(id)).toBe(true);
        }
    });

    it('has no implementer-only nodes', () => {
        const ids = new Set(createDefaultWorkflowGraph().nodes.map((node) => node.id));
        expect(ids.has('intent-gate')).toBe(false);
        expect(ids.has('delegate-wave')).toBe(false);
        expect(ids.has('evidence-check')).toBe(false);
    });

    it('plan-readonly policies deny product writes and allow .omo plan artifacts', () => {
        expect(evaluateRules('write', 'src/index.ts', [{ rules: [...DEFAULT_PLAN_READONLY_POLICIES] }]).effect).toBe(
            'deny',
        );
        expect(
            evaluateRules('write', '.omo/plans/plan.md', [{ rules: [...DEFAULT_PLAN_READONLY_POLICIES] }]).effect,
        ).toBe('allow');
        expect(
            evaluateRules('write', '.omo/drafts/x.md', [{ rules: [...DEFAULT_PLAN_READONLY_POLICIES] }]).effect,
        ).toBe('allow');
    });

    it('materializeWorkflow applies plan-readonly mode to the executed graph', () => {
        const executed = materializeWorkflow({
            name: 'default',
            graph: createDefaultWorkflowGraph(),
            modes: [DEFAULT_PLAN_READONLY_MODE],
        });
        expect(executed.policies.length).toBeGreaterThan(0);
    });
});

describe('default workflow fixture parity', () => {
    it('matches createDefaultWorkflowGraph()', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        expect(result.data.graph).toEqual(createDefaultWorkflowGraph());
        expect(result.data.modes?.[0]?.id).toBe(DEFAULT_PLAN_READONLY_MODE.id);
    });
});

describe('default workflow progress-contract routing matrix', () => {
    function nodeById(id: string) {
        const node = createDefaultWorkflowGraph().nodes.find((candidate) => candidate.id === id);
        if (node === undefined) {
            throw new Error(`missing node ${id}`);
        }
        return node;
    }

    it('locks ambiguity.classification and explore.decision outputEnum labels', () => {
        const assess = nodeById('assess-ambiguity');
        const exploreFilter = nodeById('explore-filter');
        expect(assess.config?.['outputKey']).toBe('ambiguity.classification');
        expect(assess.config?.['outputEnum']).toEqual(['clear', 'unclear', 'on-the-fence']);
        expect(exploreFilter.config?.['outputKey']).toBe('explore.decision');
        expect(exploreFilter.config?.['outputEnum']).toEqual(['needs-exploration', 'direct-draft']);
    });

    it('locks equals-used booleans with outputShape boolean', () => {
        for (const [id, key] of [
            ['explore', 'explore.complete'],
            ['research', 'research.complete'],
            ['approval-gate', 'plan.ready'],
        ] as const) {
            const node = nodeById(id);
            expect(node.config?.['outputKey']).toBe(key);
            expect(node.config?.['outputShape']).toBe('boolean');
        }
    });

    it('marks pure routing gates with empty capabilities', () => {
        for (const id of ['assess-ambiguity', 'explore-filter', 'approval-gate'] as const) {
            expect(nodeById(id).capabilities).toEqual([]);
        }
    });

    it('declares defaults.escalationTarget present for pure-gate exhaust', () => {
        expect(createDefaultWorkflowGraph().defaults?.escalationTarget).toBe('present');
        const present = nodeById('present');
        expect(present.id).toBe('present');
    });
});
