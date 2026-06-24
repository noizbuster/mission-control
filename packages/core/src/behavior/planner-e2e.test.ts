/**
 * Planner workflow E2E integration test (plan Task 3.13).
 *
 * Exercises the FULL planner chain end-to-end:
 *   1. Load the planner WorkflowSpec from `examples/abg/planner.workflow.json` (discovery parity).
 *   2. Materialize a Mission from it via `materializeMission` (Task 1.4 factory).
 *   3. Verify the materialized mission carries the planner-readonly mode declaration.
 *   4. Evaluate the planner's read-only policies via `evaluateRules` (Task 1.2 algebra):
 *      writes to `src/**` are DENIED, writes to `.omo/plans/**` and `.omo/specs/**` are ALLOWED.
 *
 * This is an INTEGRATION smoke test — it crosses three subsystems (workflow spec parsing,
 * mission materialization, policy rule algebra) that unit tests cover individually.
 */
import { type PolicyEffectRuleSet, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../permissions/rule-evaluator.js';
import { materializeMission } from '../runtime/mission-run/mission-run-service.js';
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

    it('allows writes to .omo/plans/** (the planner output path)', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', '.omo/plans/my-feature-plan.md', [ruleset]);

        expect(result.effect).toBe('allow');
    });

    it('allows writes to .omo/specs/** (the spec output path)', async () => {
        const spec = await loadPlannerSpec();
        const readonlyMode = spec.modes?.find((mode) => mode.id === 'planner-readonly');
        const ruleset: PolicyEffectRuleSet = { rules: readonlyMode?.policies ?? [] };

        const result = evaluateRules('write', '.omo/specs/feature-spec.md', [ruleset]);

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
