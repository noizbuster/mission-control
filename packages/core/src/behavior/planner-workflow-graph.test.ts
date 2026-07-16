import { AbgGraphSpecSchema, type PolicyEffectRuleSet, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../permissions/rule-evaluator';
import {
    createPlannerWorkflowGraph,
    PLANNER_READONLY_MODE,
    PLANNER_READONLY_MODE_ID,
    PLANNER_READONLY_POLICIES,
    PLANNER_WORKFLOW_GRAPH_ID,
} from './planner-workflow-graph';
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

    it('routes intake through resume-gate to approval-gate | draft-plan | assess-ambiguity', () => {
        const graph = createPlannerWorkflowGraph();
        const resumeGate = graph.nodes.find((node) => node.id === 'resume-gate');
        const fromIntake = graph.edges.filter((edge) => edge.source === 'intake' && edge.target !== 'intake');
        const fromResume = graph.edges.filter((edge) => edge.source === 'resume-gate');

        expect(resumeGate?.implementation).toBe('resume-gate');
        expect(resumeGate?.config?.['outputKey']).toBe('resume_gate');
        expect(resumeGate?.config?.['outputEnum']).toEqual(['fresh', 'resume_approval', 'resume_drafting']);
        expect(fromIntake.map((edge) => edge.target)).toEqual(['resume-gate']);
        expect(new Set(fromResume.map((edge) => edge.target))).toEqual(
            new Set(['approval-gate', 'draft-plan', 'assess-ambiguity']),
        );
        expect(fromResume.find((edge) => edge.target === 'approval-gate')?.condition).toBe('resume-approval');
        expect(fromResume.find((edge) => edge.target === 'draft-plan')?.condition).toBe('resume-drafting');
        expect(fromResume.find((edge) => edge.target === 'assess-ambiguity')?.condition).toBe('resume-fresh');
    });

    it('routes assess-ambiguity through intent-bridge to 3 ambiguity paths + self-loop', () => {
        const graph = createPlannerWorkflowGraph();
        const fromAssess = graph.edges.filter((edge) => edge.source === 'assess-ambiguity').map((edge) => edge.target);
        const fromBridge = graph.edges.filter((edge) => edge.source === 'intent-bridge').map((edge) => edge.target);
        const intentBridge = graph.nodes.find((node) => node.id === 'intent-bridge');

        expect(intentBridge?.implementation).toBe('intent-bridge');
        expect(new Set(fromAssess)).toEqual(new Set(['intent-bridge', 'assess-ambiguity']));
        expect(new Set(fromBridge)).toEqual(new Set(['explore-filter', 'research', 'ask-one-question']));
    });

    it('routes the clear branch through explore-filter into interview-loop', () => {
        const graph = createPlannerWorkflowGraph();
        const fromFilter = graph.edges.filter((edge) => edge.source === 'explore-filter');
        const fromExplore = graph.edges.filter((edge) => edge.source === 'explore');
        const fromInterview = graph.edges.filter((edge) => edge.source === 'interview-loop');
        const filterTargets = new Set(fromFilter.map((edge) => edge.target));
        const exploreTargets = new Set(fromExplore.map((edge) => edge.target));
        const interviewTargets = new Set(fromInterview.map((edge) => edge.target));

        expect(filterTargets).toContain('explore');
        expect(filterTargets).toContain('interview-loop');
        expect(filterTargets).not.toContain('draft-plan');
        expect(exploreTargets).toContain('interview-loop');
        expect(exploreTargets).not.toContain('draft-plan');
        expect(interviewTargets).toContain('interview-loop');
        expect(interviewTargets).toContain('draft-plan');
        expect(interviewTargets).toContain('adopt-defaults-announce');
        expect(
            fromInterview.find((edge) => edge.target === 'interview-loop' && edge.condition === 'interview-continue'),
        ).toBeDefined();
        expect(fromInterview.find((edge) => edge.target === 'draft-plan')?.condition).toBe('interview-clear');
        expect(fromInterview.find((edge) => edge.target === 'adopt-defaults-announce')?.condition).toBe(
            'interview-cap-adopt',
        );
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

    it('has a draft -> frontmatter -> review -> metis-gap -> dual-review lifecycle with critic floor + budgets', () => {
        const graph = createPlannerWorkflowGraph();
        const fromDraft = graph.edges.filter((edge) => edge.source === 'draft-plan');
        const fromFrontmatter = graph.edges.filter((edge) => edge.source === 'draft-frontmatter');
        const fromReview = graph.edges.filter((edge) => edge.source === 'review-plan');
        const fromMetis = graph.edges.filter((edge) => edge.source === 'metis-gap');
        const fromRejectGate = graph.edges.filter((edge) => edge.source === 'metis-reject-gate');
        const fromDualRoute = graph.edges.filter((edge) => edge.source === 'dual-review-route');
        const fromDualWave = graph.edges.filter((edge) => edge.source === 'dual-review-wave');
        const fromDualFix = graph.edges.filter((edge) => edge.source === 'dual-fix-gate');
        const fromAwaiting = graph.edges.filter((edge) => edge.source === 'draft-awaiting-approval');
        const draftFrontmatter = graph.nodes.find((node) => node.id === 'draft-frontmatter');
        const draftAwaiting = graph.nodes.find((node) => node.id === 'draft-awaiting-approval');
        const metisGap = graph.nodes.find((node) => node.id === 'metis-gap');
        const rejectGate = graph.nodes.find((node) => node.id === 'metis-reject-gate');
        const dualRoute = graph.nodes.find((node) => node.id === 'dual-review-route');
        const dualWave = graph.nodes.find((node) => node.id === 'dual-review-wave');
        const dualReviewer = graph.nodes.find((node) => node.id === 'dual-reviewer');
        const dualOracle = graph.nodes.find((node) => node.id === 'dual-oracle');
        const dualFix = graph.nodes.find((node) => node.id === 'dual-fix-gate');
        const presentBlocked = graph.nodes.find((node) => node.id === 'present-blocked');

        expect(draftFrontmatter?.implementation).toBe('draft-frontmatter');
        expect(draftFrontmatter?.config?.['status']).toBe('drafting');
        expect(draftAwaiting?.implementation).toBe('draft-frontmatter');
        expect(draftAwaiting?.config?.['status']).toBe('awaiting-approval');
        expect(draftAwaiting?.config?.['appendDualReceipts']).toBe(true);
        expect(fromDraft.find((edge) => edge.target === 'draft-frontmatter')?.condition).toBe('plan-drafted');
        expect(fromFrontmatter.map((edge) => edge.target)).toContain('review-plan');
        expect(fromAwaiting.map((edge) => edge.target)).toEqual(['approval-gate']);

        expect(metisGap?.kind).toBe('llm');
        expect(metisGap?.implementation).toBeUndefined();
        expect(metisGap?.config?.['outputKey']).toBe('metis.passed');
        expect(metisGap?.config?.['outputShape']).toBe('boolean');
        expect(rejectGate?.implementation).toBe('metis-reject-gate');
        expect(rejectGate?.config?.['outputKey']).toBe('metis.reject_route');
        expect(rejectGate?.config?.['outputEnum']).toEqual(['revise', 'escalate_present']);
        expect(dualRoute?.implementation).toBe('dual-review-route');
        expect(dualRoute?.config?.['outputKey']).toBe('dual.route');
        expect(dualRoute?.config?.['outputEnum']).toEqual(['skip', 'run']);
        expect(dualWave?.kind).toBe('parallel');
        expect(dualWave?.children).toEqual(['dual-reviewer', 'dual-oracle']);
        expect(dualWave?.config?.['verdictKey']).toBe('dual.verdict');
        expect(dualWave?.config?.['verdictStrategy']).toBe('all-approve');
        expect(dualWave?.config?.['verdictSources']).toEqual(['dual.reviewer', 'dual.oracle']);
        expect(dualReviewer?.capabilities).toEqual(['subagent']);
        expect(dualReviewer?.config?.['outputKey']).toBe('dual.reviewer');
        expect(dualReviewer?.config?.['outputEnum']).toEqual(['APPROVE', 'REJECT']);
        expect(dualOracle?.capabilities).toEqual(['subagent']);
        expect(dualOracle?.config?.['outputKey']).toBe('dual.oracle');
        expect(dualOracle?.config?.['outputEnum']).toEqual(['APPROVE', 'REJECT']);
        expect(dualFix?.implementation).toBe('dual-fix-gate');
        expect(dualFix?.config?.['outputKey']).toBe('dual.fix_route');
        expect(dualFix?.config?.['outputEnum']).toEqual(['revise', 'escalate']);
        expect(dualFix?.config?.['fixKey']).toBe('dual.fixes');
        expect(dualFix?.config?.['fixBudget']).toBe(1);
        expect(presentBlocked?.kind).toBe('llm');

        const reviewTargets = fromReview.map((edge) => edge.target);
        expect(reviewTargets).toContain('metis-gap');
        expect(reviewTargets).toContain('draft-plan');
        expect(reviewTargets).not.toContain('approval-gate');

        expect(fromReview.find((edge) => edge.target === 'metis-gap')?.condition).toBe('plan-approved');
        expect(fromReview.find((edge) => edge.target === 'draft-plan')?.condition).toBe('plan-rejected');

        expect(fromMetis.find((edge) => edge.target === 'dual-review-route')?.condition).toBe('metis-passed');
        expect(fromMetis.find((edge) => edge.target === 'metis-reject-gate')?.condition).toBe('metis-failed');
        expect(fromMetis.find((edge) => edge.target === 'approval-gate')).toBeUndefined();

        expect(fromRejectGate.find((edge) => edge.target === 'draft-plan')?.condition).toBe('metis-revise');
        expect(fromRejectGate.find((edge) => edge.target === 'present-blocked')?.condition).toBe(
            'metis-escalate-present',
        );

        expect(fromDualRoute.find((edge) => edge.target === 'draft-awaiting-approval')?.condition).toBe('dual-skip');
        expect(fromDualRoute.find((edge) => edge.target === 'dual-review-wave')?.condition).toBe('dual-run');
        expect(fromDualWave.find((edge) => edge.target === 'draft-awaiting-approval')?.condition).toBe(
            'dual-approved',
        );
        expect(fromDualWave.find((edge) => edge.target === 'dual-fix-gate')?.condition).toBe('dual-rejected');
        expect(fromDualFix.find((edge) => edge.target === 'draft-plan')?.condition).toBe('dual-revise');
        expect(fromDualFix.find((edge) => edge.target === 'present-blocked')?.condition).toBe('dual-escalate');
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

    it('keeps the graph bounded at 26 nodes or fewer after frontmatter/intent seams', () => {
        const graph = createPlannerWorkflowGraph();

        expect(graph.nodes.length).toBeLessThanOrEqual(26);
        expect(graph.nodes.map((node) => node.id)).toEqual(
            expect.arrayContaining([
                'intent-bridge',
                'draft-frontmatter',
                'draft-awaiting-approval',
                'metis-gap',
                'metis-reject-gate',
                'present-blocked',
                'dual-review-route',
                'dual-review-wave',
                'dual-reviewer',
                'dual-oracle',
                'dual-fix-gate',
            ]),
        );
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
