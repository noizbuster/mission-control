/**
 * LEVER B bi-coverage — authoring validation at materialize / authorable load.
 *
 * Given / When / Then for missing enum, orphan enum labels, equals outside enum,
 * and green paths for the four built-in workflow factories.
 */
import type { AbgGraphSpec, WorkflowSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAuthorableAbgGraph } from './authorable-graph';
import { createDefaultWorkflowGraph } from './default-workflow-graph';
import { PLANNER_READONLY_MODE } from './planner-workflow-graph';
import { createExecuterWorkflowGraph } from './executer-workflow-graph';
import { createFixerWorkflowGraph } from './fixer-workflow-graph';
import { createPlannerWorkflowGraph } from './planner-workflow-graph';
import { AbgGraphValidationError } from './rule-compiler';
import { assertRoutingKeyBiCoverage } from './routing-key-bi-coverage';
import { materializeWorkflow } from '../workflows/materialize-workflow';

function baseGraph(overrides: Partial<AbgGraphSpec> & Pick<AbgGraphSpec, 'nodes' | 'edges' | 'rules'>): AbgGraphSpec {
    return {
        id: overrides.id ?? 'bi-coverage-fixture',
        entryNodeId: overrides.entryNodeId ?? overrides.nodes[0]?.id ?? 'gate',
        nodes: overrides.nodes,
        edges: overrides.edges,
        rules: overrides.rules,
        policies: overrides.policies ?? [],
        ...(overrides.defaults !== undefined ? { defaults: overrides.defaults } : {}),
        ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    };
}

describe('assertRoutingKeyBiCoverage — LEVER B fail closed', () => {
    it('fails when equals-routed llm outputKey lacks outputEnum and boolean shape', () => {
        // Given: structured llm gate writes a key used only by conditional equals edges
        const graph = baseGraph({
            nodes: [
                {
                    id: 'gate',
                    kind: 'llm',
                    config: { outputKey: 'ambiguity.classification' },
                },
                { id: 'clear-path', kind: 'action' },
            ],
            edges: [{ source: 'gate', target: 'clear-path', condition: 'is-clear' }],
            rules: [
                {
                    id: 'is-clear',
                    when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'clear' },
                },
            ],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).toThrow(AbgGraphValidationError);
        expect(() => assertRoutingKeyBiCoverage(graph)).toThrow(/lacks outputEnum or outputShape:'boolean'/);
        expect(() => createAuthorableAbgGraph(graph)).toThrow(AbgGraphValidationError);
        expect(() =>
            materializeWorkflow({ name: 'bad', graph } satisfies WorkflowSpec),
        ).toThrow(/lacks outputEnum or outputShape:'boolean'/);
    });

    it('fails when an outputEnum label has no matching equals edge and no unconditional outbound', () => {
        // Given: enum declares on-the-fence but only clear/unclear edges exist
        const graph = baseGraph({
            nodes: [
                {
                    id: 'gate',
                    kind: 'llm',
                    config: {
                        outputKey: 'ambiguity.classification',
                        outputEnum: ['clear', 'unclear', 'on-the-fence'],
                    },
                },
                { id: 'clear-path', kind: 'action' },
                { id: 'unclear-path', kind: 'action' },
            ],
            edges: [
                { source: 'gate', target: 'clear-path', condition: 'is-clear' },
                { source: 'gate', target: 'unclear-path', condition: 'is-unclear' },
            ],
            rules: [
                {
                    id: 'is-clear',
                    when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'clear' },
                },
                {
                    id: 'is-unclear',
                    when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'unclear' },
                },
            ],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).toThrow(/outputEnum label "on-the-fence"/);
        expect(() => createAuthorableAbgGraph(graph)).toThrow(AbgGraphValidationError);
    });

    it('fails when an equals value is outside the declared outputEnum', () => {
        // Given: edge equals "poison" but enum only allows clear
        const graph = baseGraph({
            nodes: [
                {
                    id: 'gate',
                    kind: 'llm',
                    config: {
                        outputKey: 'ambiguity.classification',
                        outputEnum: ['clear'],
                    },
                },
                { id: 'clear-path', kind: 'action' },
                { id: 'poison-path', kind: 'action' },
            ],
            edges: [
                { source: 'gate', target: 'clear-path', condition: 'is-clear' },
                { source: 'gate', target: 'poison-path', condition: 'is-poison' },
            ],
            rules: [
                {
                    id: 'is-clear',
                    when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'clear' },
                },
                {
                    id: 'is-poison',
                    when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'poison' },
                },
            ],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).toThrow(/equals value "poison"/);
        expect(() => materializeWorkflow({ name: 'bad', graph })).toThrow(/not in outputEnum/);
    });

    it('accepts boolean outputShape without outputEnum for equals-routed keys', () => {
        // Given
        const graph = baseGraph({
            nodes: [
                {
                    id: 'gate',
                    kind: 'llm',
                    config: { outputKey: 'plan.ready', outputShape: 'boolean' },
                },
                { id: 'yes', kind: 'action' },
                { id: 'no', kind: 'action' },
            ],
            edges: [
                { source: 'gate', target: 'yes', condition: 'ready-true' },
                { source: 'gate', target: 'no', condition: 'ready-false' },
            ],
            rules: [
                {
                    id: 'ready-true',
                    when: { kind: 'blackboard.value.equals', key: 'plan.ready', value: true },
                },
                {
                    id: 'ready-false',
                    when: { kind: 'blackboard.value.equals', key: 'plan.ready', value: false },
                },
            ],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).not.toThrow();
        expect(() => createAuthorableAbgGraph(graph)).not.toThrow();
    });

    it('accepts orphan enum labels when an unconditional outbound edge exists', () => {
        // Given
        const graph = baseGraph({
            nodes: [
                {
                    id: 'gate',
                    kind: 'llm',
                    config: {
                        outputKey: 'ambiguity.classification',
                        outputEnum: ['clear', 'unclear', 'on-the-fence'],
                    },
                },
                { id: 'fallback', kind: 'action' },
            ],
            edges: [{ source: 'gate', target: 'fallback' }],
            rules: [],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).not.toThrow();
    });

    it('exempts non-structured writers (critic / supervisor / custom implementation)', () => {
        // Given: equals-routed keys written only by non-structured runners
        const graph = baseGraph({
            nodes: [
                {
                    id: 'verify',
                    kind: 'llm',
                    implementation: 'critic',
                    config: { outputKey: 'critic.passed' },
                },
                {
                    id: 'supervisor',
                    kind: 'llm',
                    implementation: 'supervisor',
                    config: { maxAttempts: 3 },
                },
                { id: 'retry', kind: 'action' },
                { id: 'done', kind: 'action' },
            ],
            edges: [
                { source: 'verify', target: 'done', condition: 'critic-ok' },
                { source: 'supervisor', target: 'retry', condition: 'sup-retry' },
            ],
            rules: [
                {
                    id: 'critic-ok',
                    when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: true },
                },
                {
                    id: 'sup-retry',
                    when: { kind: 'blackboard.value.equals', key: 'supervisor.action', value: 'retry' },
                },
            ],
        });

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).not.toThrow();
        expect(() => createAuthorableAbgGraph(graph)).not.toThrow();
    });
});

describe('assertRoutingKeyBiCoverage — built-in workflows green', () => {
    it.each([
        ['default', () => createDefaultWorkflowGraph()],
        ['planner', () => createPlannerWorkflowGraph()],
        ['executer', () => createExecuterWorkflowGraph()],
        ['fixer', () => createFixerWorkflowGraph()],
    ] as const)('%s factory materializes and authorable-loads', (_name, factory) => {
        // Given
        const graph = factory();

        // When / Then
        expect(() => assertRoutingKeyBiCoverage(graph)).not.toThrow();
        expect(() => createAuthorableAbgGraph(graph)).not.toThrow();
        expect(() => materializeWorkflow({ name: _name, graph })).not.toThrow();
    });

    it('default materialize with no modes still passes bi-coverage', () => {
        expect(() =>
            materializeWorkflow({
                name: 'default',
                graph: createDefaultWorkflowGraph(),
            }),
        ).not.toThrow();
    });

    it('planner materialize with plan-readonly mode still passes bi-coverage', async () => {
        const { createPlannerWorkflowGraph } = await import('./planner-workflow-graph');
        expect(() =>
            materializeWorkflow({
                name: 'planner',
                graph: createPlannerWorkflowGraph(),
                modes: [PLANNER_READONLY_MODE],
            }),
        ).not.toThrow();
    });
});
