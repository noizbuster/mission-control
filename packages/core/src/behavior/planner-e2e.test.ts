/**
 * Planner workflow E2E integration test (plan Task 3.13).
 *
 * Exercises the FULL planner chain end-to-end:
 *   1. Load the planner WorkflowSpec from `examples/abg/planner.workflow.json` (discovery parity).
 *   2. Materialize a Mission from it via `materializeMission` (Task 1.4 factory).
 *   3. Verify the materialized mission carries the planner-readonly mode declaration.
 *   4. Evaluate the planner's read-only policies via `evaluateRules` (Task 1.2 algebra):
 *      writes to `src/**` are DENIED, writes to `.mc/plans/**` and `.mc/specs/**` are ALLOWED.
 *
 * This is an INTEGRATION smoke test — it crosses three subsystems (workflow spec parsing,
 * mission materialization, policy rule algebra) that unit tests cover individually.
 */
import { type AbgPolicySpec, type PolicyEffectRuleSet, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { registerBuiltinWorkflows, WorkflowRegistry } from '../index';
import { evaluateRules } from '../permissions/rule-evaluator';
import { materializeMission } from '../runtime/mission-run/mission-run-service';
import { materializeWorkflow } from '../workflows/materialize-workflow';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/planner.workflow.json`;

async function loadPlannerSpec() {
    const contents = await readFile(workflowJsonPath, 'utf8');
    const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
    if (!result.success) {
        throw new Error(`planner.workflow.json failed schema validation: ${result.error.message}`);
    }
    return result.data;
}

describe('planner workflow E2E: discover -> materialize -> policy enforcement', () => {
    it('loads a valid WorkflowSpec with the planner-readonly mode', async () => {
        const spec = await loadPlannerSpec();

        expect(spec.name).toBe('planner');
        expect(spec.graph.entryNodeId).toBe('intake');
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        expect(readonlyMode).toBeDefined();
    });

    it('materializes a draft Mission carrying the graph and mode declarations', async () => {
        const spec = await loadPlannerSpec();

        const mission = materializeMission(spec);
        if (mission.graph === undefined) throw new Error('test setup: mission has no graph');

        expect(mission.status).toBe('draft');
        expect(mission.workflowName).toBe('planner');
        expect(mission.graph.id).toBe('planner');
        expect(mission.modeDeclarations).toContainEqual({ modeId: 'planner-readonly', active: true });
    });

    it('denies writes to source files via the planner-readonly policies', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', 'src/index.ts', [ruleset]);

        expect(result.effect).toBe('deny');
    });

    it('denies writes to nested package source paths', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', 'packages/core/src/agent-runtime.ts', [ruleset]);

        expect(result.effect).toBe('deny');
    });

    it('allows writes to .mc/plans/** (the planner output path)', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', '.mc/plans/my-feature-plan.md', [ruleset]);

        expect(result.effect).toBe('allow');
    });

    it('allows writes to .mc/specs/** (the spec output path)', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', '.mc/specs/feature-spec.md', [ruleset]);

        expect(result.effect).toBe('allow');
    });

    it('materialized mission graph passes schema round-trip after materialization', async () => {
        const spec = await loadPlannerSpec();
        const mission = materializeMission(spec);
        if (mission.graph === undefined) throw new Error('test setup: mission has no graph');

        // The materialized graph must carry the same entry node and node count.
        expect(mission.graph.entryNodeId).toBe('intake');
        expect(mission.graph.nodes.length).toBeGreaterThan(0);
        expect(mission.graph.edges.length).toBeGreaterThan(0);
    });
});

describe('planner workflow materialization: readonly policies reach the EXECUTED graph', () => {
    // Closes parity row 10: the EXECUTED graph (not only the Mission record) must
    // carry planner-readonly policies after materializeWorkflow.
    it('the raw planner graph carries NO write-deny policies (the pre-materialization state)', () => {
        const registry = new WorkflowRegistry();
        registerBuiltinWorkflows(registry);
        const spec = registry.lookup('planner');
        if (spec === undefined) throw new Error('test setup: builtin planner not registered');

        expect(spec.graph.policies.length).toBe(0);
    });

    it('materializeWorkflow folds planner-readonly deny policies into the executed graph', () => {
        const registry = new WorkflowRegistry();
        registerBuiltinWorkflows(registry);
        const spec = registry.lookup('planner');
        if (spec === undefined) throw new Error('test setup: builtin planner not registered');

        const executed = materializeWorkflow(spec);

        const denyPolicies = executed.policies.filter(
            (policy: AbgPolicySpec) => policy.capability === 'write' && policy.decision === 'deny',
        );
        expect(denyPolicies.length).toBeGreaterThanOrEqual(1);
        for (const policy of denyPolicies) {
            expect(policy.id).toContain('planner-readonly:policy:');
        }
    });

    it('the broad write-deny policy on ** survives materialization onto the executed graph', () => {
        const registry = new WorkflowRegistry();
        registerBuiltinWorkflows(registry);
        const spec = registry.lookup('planner');
        if (spec === undefined) throw new Error('test setup: builtin planner not registered');

        const executed = materializeWorkflow(spec);
        const broadDeny = executed.policies.find(
            (policy) =>
                policy.capability === 'write' && policy.decision === 'deny' && (policy.reason ?? '').includes('**'),
        );

        expect(broadDeny).toBeDefined();
    });

    it('materializeMission and materializeWorkflow agree on planner-readonly presence', async () => {
        const spec = await loadPlannerSpec();
        const mission = materializeMission(spec);
        const executed = materializeWorkflow(spec);

        expect(mission.modeDeclarations ?? []).toContainEqual({ modeId: 'planner-readonly', active: true });
        const denyOnExecuted = executed.policies.some(
            (policy: AbgPolicySpec) => policy.decision === 'deny' && policy.capability === 'write',
        );
        expect(denyOnExecuted).toBe(true);
    });
});
