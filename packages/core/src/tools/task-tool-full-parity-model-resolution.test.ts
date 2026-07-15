import type { AbgNodeModelOptions, AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ModelPattern } from '../agents/model-resolver';
import type { ModelRole } from '../agents/model-roles';
import { buildResolveModelFn } from './task-tool-full-parity-factory';

const MODELS = {
    concrete: { providerID: 'concrete', modelID: 'concrete-model' },
    named: { providerID: 'named', modelID: 'named-model' },
    parent: { providerID: 'parent', modelID: 'parent-model', variantID: 'parent-variant' },
    role: { providerID: 'role', modelID: 'role-model' },
    session: { providerID: 'session', modelID: 'session-model', variantID: 'session-variant' },
    taskRole: { providerID: 'task-role', modelID: 'task-role-model' },
} as const satisfies Readonly<Record<string, ModelPattern>>;

type FactoryCase = {
    readonly name: string;
    readonly agentModel?: AgentDefinition['model'];
    readonly override?: ModelPattern;
    readonly parentActiveModel?: AbgNodeModelOptions;
    readonly roleConfig?: Partial<Record<ModelRole, ModelPattern>>;
    readonly expected: ModelPattern;
};

const FACTORY_CASES: readonly FactoryCase[] = [
    {
        name: 'exact mctrl/task inherits the parent instead of named and role overrides',
        agentModel: 'mctrl/task',
        override: MODELS.named,
        parentActiveModel: MODELS.parent,
        roleConfig: { task: MODELS.taskRole },
        expected: MODELS.parent,
    },
    {
        name: 'named override wins over a configured role alias',
        agentModel: 'mctrl/slow',
        override: MODELS.named,
        parentActiveModel: MODELS.parent,
        roleConfig: { slow: MODELS.role },
        expected: MODELS.named,
    },
    {
        name: 'named override wins over a concrete agent model',
        agentModel: MODELS.concrete,
        override: MODELS.named,
        parentActiveModel: MODELS.parent,
        expected: MODELS.named,
    },
    {
        name: 'concrete agent model resolves without role configuration',
        agentModel: MODELS.concrete,
        parentActiveModel: MODELS.parent,
        expected: MODELS.concrete,
    },
    {
        name: 'configured role alias resolves before parent fallback',
        agentModel: 'mctrl/slow',
        parentActiveModel: MODELS.parent,
        roleConfig: { slow: MODELS.role },
        expected: MODELS.role,
    },
    {
        name: 'parent active model resolves before the session default',
        parentActiveModel: MODELS.parent,
        expected: MODELS.parent,
    },
    {
        name: 'session default is used when no parent is active',
        expected: MODELS.session,
    },
];

describe('buildResolveModelFn precedence matrix', () => {
    for (const testCase of FACTORY_CASES) {
        it(testCase.name, () => {
            // Given
            const overrides =
                testCase.override === undefined
                    ? undefined
                    : new Map<string, ModelPattern>([['matrix-agent', testCase.override]]);
            const resolveModel = buildResolveModelFn({
                model: MODELS.session,
                ...(testCase.parentActiveModel !== undefined ? { parentActiveModel: testCase.parentActiveModel } : {}),
                ...(overrides !== undefined ? { agentModelOverrides: overrides } : {}),
                ...(testCase.roleConfig !== undefined ? { roleConfig: testCase.roleConfig } : {}),
            });
            const child: AgentDefinition = {
                name: 'matrix-agent',
                description: 'Factory model precedence matrix agent',
                systemPrompt: 'Resolve my model.',
                source: 'bundled',
                ...(testCase.agentModel !== undefined ? { model: testCase.agentModel } : {}),
            };

            // When
            const resolved = resolveModel(child);

            // Then
            expect(resolved).toEqual(testCase.expected);
        });
    }
});
