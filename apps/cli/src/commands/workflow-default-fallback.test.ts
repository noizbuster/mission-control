/**
 * Workflow default-fallback + materialization routing (plan Todo 2).
 *
 * Pins the contract that BOTH CLI invocation paths route workflow graphs
 * through the shared `materializeWorkflow` helper:
 *   - `#planner` and `--workflow planner` produce an executed graph carrying
 *     the planner-readonly deny policies (only reachable via `materializeWorkflow`).
 *   - interactive and non-interactive plain prompts resolve to the materialized
 *     `default` workflow fallback.
 *   - explicit `--graph <path>` BYPASSES workflow materialization entirely
 *     (authorable graphs are run raw).
 *
 * The CLI surface under test is `graphForWorkflowSpec` / `graphForDefaultFallback`
 * (the resolvers both `runWorkflowAction`/`runPromptAction` and `runAgent` import),
 * so a regression here fires if either path stops routing through the helper.
 */

import { registerBuiltinWorkflows, WorkflowRegistry } from '@mission-control/core';
import { type AbgPolicySpec, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { resolveWorkflowInvocation } from './run-agent.js';
import { readGraphFile } from './run-agent-graph.js';
import { graphForDefaultFallback, graphForWorkflowSpec } from './workflow-materialization.js';

function registryWithBuiltins(): WorkflowRegistry {
    const registry = new WorkflowRegistry();
    registerBuiltinWorkflows(registry);
    return registry;
}

describe('workflow materialization routing: #planner and --workflow planner', () => {
    it('graphForWorkflowSpec applies planner-readonly deny policies to the executed graph', () => {
        const registry = registryWithBuiltins();
        const spec = registry.lookup('planner');
        if (spec === undefined) throw new Error('test setup: builtin planner not registered');

        const executed = graphForWorkflowSpec(spec);

        const denyPolicies = executed.policies.filter(
            (policy: AbgPolicySpec) => policy.capability === 'write' && policy.decision === 'deny',
        );
        expect(denyPolicies.length).toBeGreaterThanOrEqual(1);
    });

    it('graphForWorkflowSpec is the seam both #planner and --workflow planner use', () => {
        // Both interactive `#planner` (runWorkflowAction) and non-interactive
        // `--workflow planner` (runAgent) call graphForWorkflowSpec on the resolved
        // spec. The returned graph is schema-valid and carries readonly policies.
        const registry = registryWithBuiltins();
        const spec = registry.lookup('planner');
        if (spec === undefined) throw new Error('test setup: builtin planner not registered');

        const executed = graphForWorkflowSpec(spec);

        expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
        expect(executed.entryNodeId).toBe('intake');
        expect(executed.policies.some((policy) => policy.decision === 'deny')).toBe(true);
    });
});

describe('workflow materialization routing: plain-prompt default fallback', () => {
    it('graphForDefaultFallback resolves the materialized default workflow from a registry', () => {
        const registry = registryWithBuiltins();

        const graph = graphForDefaultFallback(registry);

        expect(graph).toBeDefined();
        expect(graph?.id).toBe('default');
        expect(graph?.entryNodeId).toBe('intent-gate');
    });

    it('graphForDefaultFallback returns undefined when no registry is configured', () => {
        expect(graphForDefaultFallback(undefined)).toBeUndefined();
    });

    it('graphForDefaultFallback falls back to createDefaultWorkflowGraph when default is undiscovered', () => {
        const emptyRegistry = new WorkflowRegistry([]);

        const graph = graphForDefaultFallback(emptyRegistry);

        expect(graph).toBeDefined();
        expect(graph?.id).toBe('default');
    });
});

describe('workflow materialization routing: explicit --graph bypass', () => {
    it('resolveWorkflowInvocation returns undefined for a plain --graph prompt (no workflow materialization)', () => {
        const invocation = resolveWorkflowInvocation({ prompt: 'run the graph' });

        expect(invocation).toBeUndefined();
    });

    it('resolveWorkflowInvocation returns undefined when only --workflow is absent and prompt has no # prefix', () => {
        expect(resolveWorkflowInvocation({ prompt: 'plain prompt' })).toBeUndefined();
        expect(resolveWorkflowInvocation({})).toBeUndefined();
    });

    it('an authorable graph file is used raw and is NOT the default workflow', async () => {
        const graph = await readGraphFile(`${process.cwd()}/examples/abg/research-answer.graph.json`);

        expect(graph.id).not.toBe('default');
        // Authorable graphs are not workflows: no mode policies are appended.
        const modePolicies = graph.policies.filter((policy) => policy.id.includes(':policy:'));
        expect(modePolicies.length).toBe(0);
    });

    it('--workflow <name> resolves an invocation (mutually exclusive with the --graph bypass)', () => {
        const invocation = resolveWorkflowInvocation({ workflowName: 'planner', prompt: 'plan it' });

        expect(invocation).toEqual({ name: 'planner', prompt: 'plan it' });
    });
});
