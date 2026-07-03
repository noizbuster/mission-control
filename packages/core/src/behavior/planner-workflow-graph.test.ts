import { AbgGraphSpecSchema, type PolicyEffectRuleSet, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../permissions/rule-evaluator.js';
import {
    createPlannerWorkflowGraph,
    PLANNER_READONLY_MODE,
    PLANNER_READONLY_MODE_ID,
    PLANNER_READONLY_POLICIES,
    PLANNER_WORKFLOW_GRAPH_ID,
} from './planner-workflow-graph.js';
import { readFile } from 'node:fs/promises';

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

    it('routes from assess-ambiguity to 3 ambiguity paths + self-loop (clear->explore-filter, unclear->research, on-the-fence->ask-one-question, loop)', () => {
        const graph = createPlannerWorkflowGraph();
        const targets = graph.edges.filter((edge) => edge.source === 'assess-ambiguity').map((edge) => edge.target);
        const uniqueTargets = new Set(targets);

        expect(uniqueTargets.size).toBe(4);
        expect(uniqueTargets).toContain('explore-filter');
        expect(uniqueTargets).toContain('research');
        expect(uniqueTargets).toContain('ask-one-question');
        expect(uniqueTargets).toContain('assess-ambiguity');
    });

    it('routes the clear branch through explore-filter (needs-exploration vs direct-draft)', () => {
        const graph = createPlannerWorkflowGraph();
        const targets = graph.edges.filter((edge) => edge.source === 'explore-filter').map((edge) => edge.target);
        const uniqueTargets = new Set(targets);

        expect(uniqueTargets).toContain('explore');
        expect(uniqueTargets).toContain('draft-plan');
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

    it('has a draft -> review -> approval-gate lifecycle with a critic retry loop', () => {
        const graph = createPlannerWorkflowGraph();
        const fromReview = graph.edges.filter((edge) => edge.source === 'review-plan');

        const targets = fromReview.map((edge) => edge.target);
        expect(targets).toContain('approval-gate');
        expect(targets).toContain('draft-plan');

        const approvedEdge = fromReview.find((edge) => edge.target === 'approval-gate');
        const rejectedEdge = fromReview.find((edge) => edge.target === 'draft-plan');
        expect(approvedEdge?.condition).toBe('plan-approved');
        expect(rejectedEdge?.condition).toBe('plan-rejected');
    });

    it('gates the final plan write behind an approval gate (plan.ready) then routes to present', () => {
        const graph = createPlannerWorkflowGraph();
        const fromApproval = graph.edges.filter((edge) => edge.source === 'approval-gate');

        const targets = fromApproval.map((edge) => edge.target);
        expect(targets).toContain('write-plan');
        expect(targets).toContain('approval-gate');

        const readyEdge = fromApproval.find((edge) => edge.target === 'write-plan');
        const awaitingEdge = fromApproval.find((edge) => edge.target === 'approval-gate');
        expect(readyEdge?.condition).toBe('plan-ready');
        expect(awaitingEdge?.condition).toBe('plan-awaiting-approval');

        const writePlanToPresent = graph.edges.find(
            (edge) => edge.source === 'write-plan' && edge.target === 'present',
        );
        expect(writePlanToPresent?.condition).toBe('plan-written');
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
