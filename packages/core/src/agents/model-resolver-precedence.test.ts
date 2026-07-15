import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ModelPattern, ResolveAgentModelInput } from './model-resolver.js';
import { resolveAgentModel } from './model-resolver.js';

const MODELS = {
    concrete: { providerID: 'concrete', modelID: 'concrete-model' },
    named: { providerID: 'named', modelID: 'named-model' },
    parent: { providerID: 'parent', modelID: 'parent-model' },
    role: { providerID: 'role', modelID: 'role-model' },
    session: { providerID: 'session', modelID: 'session-model' },
    taskRole: { providerID: 'task-role', modelID: 'task-role-model' },
} as const satisfies Readonly<Record<string, ModelPattern>>;

type PrecedenceCase = {
    readonly name: string;
    readonly agentModel?: AgentDefinition['model'];
    readonly agentModelOverride?: ModelPattern;
    readonly parentActiveModel?: ModelPattern;
    readonly roleConfig?: ResolveAgentModelInput['roleConfig'];
    readonly expected: ModelPattern;
};

const PRECEDENCE_CASES: readonly PrecedenceCase[] = [
    {
        name: 'exact mctrl/task inherits the parent despite every conflicting override',
        agentModel: 'mctrl/task',
        agentModelOverride: MODELS.named,
        parentActiveModel: MODELS.parent,
        roleConfig: { task: MODELS.taskRole },
        expected: MODELS.parent,
    },
    {
        name: 'exact mctrl/task inherits the session default without a parent',
        agentModel: 'mctrl/task',
        agentModelOverride: MODELS.named,
        roleConfig: { task: MODELS.taskRole },
        expected: MODELS.session,
    },
    {
        name: 'named override wins over a concrete agent model',
        agentModel: MODELS.concrete,
        agentModelOverride: MODELS.named,
        parentActiveModel: MODELS.parent,
        expected: MODELS.named,
    },
    {
        name: 'named override wins over a configured role alias',
        agentModel: 'mctrl/slow',
        agentModelOverride: MODELS.named,
        parentActiveModel: MODELS.parent,
        roleConfig: { slow: MODELS.role },
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
        name: 'parent active model wins when the agent model is absent',
        parentActiveModel: MODELS.parent,
        expected: MODELS.parent,
    },
    {
        name: 'session default is the final fallback',
        expected: MODELS.session,
    },
];

describe('resolveAgentModel precedence matrix', () => {
    for (const testCase of PRECEDENCE_CASES) {
        it(testCase.name, () => {
            // Given
            const agent: AgentDefinition = {
                name: 'matrix-agent',
                description: 'Model precedence matrix agent',
                systemPrompt: 'Resolve my model.',
                source: 'bundled',
                ...(testCase.agentModel !== undefined ? { model: testCase.agentModel } : {}),
            };
            const input: ResolveAgentModelInput = {
                agent,
                sessionDefault: MODELS.session,
                roleConfig: testCase.roleConfig ?? {},
                ...(testCase.agentModelOverride !== undefined
                    ? { agentModelOverride: testCase.agentModelOverride }
                    : {}),
                ...(testCase.parentActiveModel !== undefined ? { parentActiveModel: testCase.parentActiveModel } : {}),
            };

            // When
            const resolved = resolveAgentModel(input);

            // Then
            expect(resolved).toEqual(testCase.expected);
        });
    }
});
