/**
 * Autopilot mode E2E integration test (plan Task 3.13).
 *
 * Exercises the FULL autopilot application chain on a real graph:
 *   1. Build the planner workflow graph (a real, multi-node llm graph).
 *   2. Apply `autopilotMode` via `applyMode` (the pure structural transform).
 *   3. Verify every llm-actor node now carries the autopilot certainty directives in its
 *      system prompt (prepended, not replaced).
 *   4. Verify an edit-gate policy was added with `requires_approval` decision.
 *   5. Run the real `runModePolicyGateNode` against an edit action and confirm it resolves
 *      to `requires_approval` — the edit-without-scenario gate is enforced at the policy layer.
 *
 * This crosses mode declaration (3.8), mode application (3.8), real graph nodes (3.1), and
 * the mode-policy-gate node (3.2) — none of which the unit tests exercise together.
 */
import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { AbgNodeRunContext } from '../node-registry.js';
import { runModePolicyGateNode } from '../nodes/policy-gate-node.js';
import { createPlannerWorkflowGraph } from '../planner-workflow-graph.js';
import { autopilotMode } from './autopilot-mode.js';
import { applyMode } from './mode-application.js';

const NOW = '2026-06-22T00:00:00.000Z';

function configString(node: { readonly config?: Readonly<Record<string, unknown>> | undefined } | undefined, key: string): string | undefined {
    const value = node?.config?.[key];
    return typeof value === 'string' ? value : undefined;
}

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

describe('autopilot mode E2E: applyMode on real graph + policy gate enforcement', () => {
    it('prepends autopilot certainty directives to every llm-actor node prompt', () => {
        const graph = createPlannerWorkflowGraph();
        const llmNodes = graph.nodes.filter((node) => node.kind === 'llm');
        expect(llmNodes.length).toBeGreaterThan(0);

        const result = applyMode(graph, autopilotMode);

        for (const node of result.nodes.filter((n) => n.kind === 'llm')) {
            const prompt = configString(node, 'systemPrompt');
            expect(prompt).toBeDefined();
            expect(prompt).toContain('certainty before action');
            expect(prompt).toContain('scenario before edit');
        }
    });

    it('preserves the original node-specific prompt below the autopilot overlay', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);

        const intakeNode = result.nodes.find((node) => node.id === 'intake');
        const prompt = configString(intakeNode, 'systemPrompt');

        expect(prompt).toContain('autopilot mode');
        expect(prompt).toContain('Summarize the user planning request');
        const overlayIdx = prompt?.indexOf('autopilot mode') ?? -1;
        const originalIdx = prompt?.indexOf('Summarize the user planning request') ?? -1;
        expect(overlayIdx).toBeLessThan(originalIdx);
    });

    it('adds an edit-gate policy with requires_approval decision', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);

        const editPolicy = result.policies.find((policy) => policy.capability === 'edit');

        expect(editPolicy).toBeDefined();
        expect(editPolicy?.decision).toBe('requires_approval');
    });

    it('does NOT add policies for non-edit actions', () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);

        const readPolicy = result.policies.find((policy) => policy.capability === 'read');
        expect(readPolicy).toBeUndefined();
    });

    it('blocks an edit action via the mode-policy-gate node (requires approval)', async () => {
        const graph = createPlannerWorkflowGraph();
        const result = applyMode(graph, autopilotMode);
        const editPolicy = result.policies.find((policy) => policy.capability === 'edit');
        expect(editPolicy).toBeDefined();

        // The mode-policy-gate node reads action/resource from config + policies from context.
        // Autopilot's policy is `{ action: 'edit', resource: '**', effect: 'ask' }`, converted to
        // AbgPolicySpec by applyMode. We feed the ORIGINAL mode policies (action/resource/effect)
        // via context.modePolicies to exercise the actual gate.
        const modeRules = autopilotMode.policies;
        const context: AbgNodeRunContext = {
            graphId: 'autopilot-e2e',
            now: () => NOW,
            modePolicies: modeRules,
        };
        const node = {
            id: 'edit-gate',
            kind: 'policy' as const,
            implementation: 'mode-policy-gate' as const,
            config: { action: 'edit', resource: 'src/foo.ts' },
        };

        const signals = await collectSignals(runModePolicyGateNode(node, context));
        const emit = signals.find((s): s is Extract<AbgSignal, { type: 'emit' }> => s.type === 'emit');

        expect(emit).toBeDefined();
        const payload = emit?.event.payload as { readonly decision: string; readonly effect: string };
        expect(payload.decision).toBe('requires_approval');
        expect(payload.effect).toBe('ask');
    });
});
