import {
    AbgGraphSpecSchema,
    WorkflowSpecSchema,
    type PolicyEffectRuleSet,
} from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
    createPlannerWorkflowGraph,
    PLANNER_READONLY_MODE,
    PLANNER_READONLY_MODE_ID,
    PLANNER_READONLY_POLICIES,
    PLANNER_WORKFLOW_GRAPH_ID,
} from './planner-workflow-graph.js';
import { evaluateRules } from '../permissions/rule-evaluator.js';

const workflowJsonPath = `${process.cwd()}/examples/abg/planner.workflow.json`;

describe('createPlannerWorkflowGraph', () => {
    it('returns a schema-valid AbgGraphSpec', () => {
        const graph = createPlannerWorkflowGraph();

        const result = AbgGraphSpecSchema.safeParse(graph);

        expect(result.success).toBe(true);
    });

    it('uses "planner" as the graph id', () => {
        const graph = createPlannerWorkflowGraph();

        expect(graph.id).toBe(PLANNER_WORKFLOW_GRAPH_ID);
        expect(graph.id).toBe('planner');
    });

    it('has intake as the entry node', () => {
        const graph = createPlannerWorkflowGraph();
        const nodeIds = graph.nodes.map((node) => node.id);

        expect(graph.entryNodeId).toBe('intake');
        expect(nodeIds).toContain('intake');
    });

    it('routes from assess-ambiguity to exactly 3 ambiguity paths (clear, unclear, on-the-fence)', () => {
        const graph = createPlannerWorkflowGraph();
        const targets = graph.edges
            .filter((edge) => edge.source === 'assess-ambiguity')
            .map((edge) => edge.target);
        const uniqueTargets = new Set(targets);

        expect(uniqueTargets.size).toBe(3);
        expect(uniqueTargets).toContain('explore');
        expect(uniqueTargets).toContain('research');
        expect(uniqueTargets).toContain('ask-one-question');
    });

    it('uses llm node kind and critic implementation', () => {
        const graph = createPlannerWorkflowGraph();
        const kinds = new Set(graph.nodes.map((node) => node.kind));
        const implementations = graph.nodes
            .map((node) => node.implementation)
            .filter((value): value is string => value !== undefined);

        expect(kinds.has('llm')).toBe(true);
        expect(implementations).toContain('critic');
    });

    it('has draft-plan and review-plan nodes wired via plan.drafted / plan.approved blackboard keys', () => {
        const graph = createPlannerWorkflowGraph();
        const draftPlan = graph.nodes.find((node) => node.id === 'draft-plan');
        const reviewPlan = graph.nodes.find((node) => node.id === 'review-plan');

        expect(draftPlan?.config?.['outputKey']).toBe('plan.drafted');
        expect(reviewPlan?.implementation).toBe('critic');
        expect(reviewPlan?.config?.['outputKey']).toBe('plan.approved');
    });

    it('has a critic retry loop: review-plan -> draft-plan on rejection and review-plan -> present on approval', () => {
        const graph = createPlannerWorkflowGraph();
        const fromReview = graph.edges.filter((edge) => edge.source === 'review-plan');

        const targets = fromReview.map((edge) => edge.target);
        expect(targets).toContain('present');
        expect(targets).toContain('draft-plan');

        const approvedEdge = fromReview.find((edge) => edge.target === 'present');
        const rejectedEdge = fromReview.find((edge) => edge.target === 'draft-plan');
        expect(approvedEdge?.condition).toBe('plan-approved');
        expect(rejectedEdge?.condition).toBe('plan-rejected');
    });

    it('keeps the graph bounded at 15 nodes or fewer', () => {
        const graph = createPlannerWorkflowGraph();

        expect(graph.nodes.length).toBeLessThanOrEqual(15);
    });

    it('accepts custom model and maxNodeRuns options', () => {
        const graph = createPlannerWorkflowGraph({
            model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
            maxNodeRuns: 10,
        });

        expect(graph.defaults?.model?.providerID).toBe('anthropic');
        expect(graph.defaults?.maxNodeRuns).toBe(10);
    });
});

describe('PLANNER_READONLY_POLICIES', () => {
    const ruleset: PolicyEffectRuleSet = { rules: [...PLANNER_READONLY_POLICIES] };

    it('denies writes to arbitrary source paths', () => {
        const result = evaluateRules('write', 'src/foo.ts', [ruleset]);

        expect(result.effect).toBe('deny');
    });

    it('allows writes to .omo/plans/**', () => {
        const result = evaluateRules('write', '.omo/plans/my-plan.md', [ruleset]);

        expect(result.effect).toBe('allow');
    });

    it('allows writes to .omo/specs/**', () => {
        const result = evaluateRules('write', '.omo/specs/feature-spec.md', [ruleset]);

        expect(result.effect).toBe('allow');
    });

    it('denies writes to nested source paths', () => {
        const result = evaluateRules('write', 'packages/core/src/index.ts', [ruleset]);

        expect(result.effect).toBe('deny');
    });

    it('declares the planner-readonly mode id', () => {
        expect(PLANNER_READONLY_MODE.id).toBe(PLANNER_READONLY_MODE_ID);
        expect(PLANNER_READONLY_MODE.id).toBe('planner-readonly');
    });
});

describe('examples/abg/planner.workflow.json', () => {
    it('parses via WorkflowSpecSchema', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');

        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
    });

    it('has name "planner" with intake entry node', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.name).toBe('planner');
        expect(result.data.graph.entryNodeId).toBe('intake');
    });

    it('produces a graph identical to createPlannerWorkflowGraph()', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.data.graph).toEqual(createPlannerWorkflowGraph());
    });

    it('declares the planner-readonly mode with deny-all-writes-except policies', async () => {
        const contents = await readFile(workflowJsonPath, 'utf8');
        const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        const modes = result.data.modes ?? [];
        const readonlyMode = modes.find((mode) => mode.id === PLANNER_READONLY_MODE_ID);

        expect(readonlyMode).toBeDefined();
        expect(readonlyMode?.policies).toEqual([...PLANNER_READONLY_POLICIES]);
    });
});
