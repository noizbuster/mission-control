import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ModelPattern, ResolveAgentModelInput } from './model-resolver.js';
import { DEFAULT_ROLE_CONFIG, resolveAgentModel } from './model-resolver.js';

function makeAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
        name: 'test-agent',
        description: 'Test agent',
        systemPrompt: 'You are a test agent.',
        source: 'bundled',
        ...overrides,
    };
}

const SESSION_DEFAULT: ModelPattern = { providerID: 'session-provider', modelID: 'session-model' };

describe('resolveAgentModel', () => {
    describe('tier 1 — settingsOverride (highest)', () => {
        it('returns settingsOverride when present, winning over agent.model', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/slow' }),
                sessionDefault: SESSION_DEFAULT,
                settingsOverride: { providerID: 'override', modelID: 'model' },
                roleConfig: { slow: { providerID: 'x', modelID: 'y' } },
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'override', modelID: 'model' });
        });

        it('returns settingsOverride even when agent.model is a concrete object', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: { providerID: 'a', modelID: 'b' } }),
                sessionDefault: SESSION_DEFAULT,
                settingsOverride: { providerID: 'override', modelID: 'model' },
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'override', modelID: 'model' });
        });
    });

    describe('tier 2 — agent.model', () => {
        it('resolves mctrl/<role> alias through roleConfig', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/slow' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: { slow: { providerID: 'x', modelID: 'y' } },
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'x', modelID: 'y' });
        });

        it('returns sessionDefault for mctrl/task even when roleConfig has a task entry', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/task' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: { task: { providerID: 'should-not-be-used', modelID: 'no' } },
            };
            expect(resolveAgentModel(input)).toEqual(SESSION_DEFAULT);
        });

        it('passes through a concrete { providerID, modelID } object', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: { providerID: 'a', modelID: 'b' } }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'a', modelID: 'b' });
        });

        it('resolves legacy opus alias through LEGACY_CATEGORY_MODEL_ALIASES to roleConfig.slow', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'opus' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: { slow: { providerID: 'legacy', modelID: 'opus-replacement' } },
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'legacy', modelID: 'opus-replacement' });
        });

        it('resolves legacy sonnet alias through LEGACY_CATEGORY_MODEL_ALIASES to roleConfig.default', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'sonnet' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: { default: { providerID: 'legacy', modelID: 'sonnet-replacement' } },
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'legacy', modelID: 'sonnet-replacement' });
        });

        it('falls through to parentActiveModel when alias resolves but roleConfig lacks the role', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/slow' }),
                sessionDefault: SESSION_DEFAULT,
                parentActiveModel: { providerID: 'p', modelID: 'm' },
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'p', modelID: 'm' });
        });

        it('falls through when legacy alias resolves but roleConfig lacks the mapped role', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'opus' }),
                sessionDefault: SESSION_DEFAULT,
                parentActiveModel: { providerID: 'p', modelID: 'm' },
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'p', modelID: 'm' });
        });

        it('falls through for an unrecognized string model', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'unknown-model' }),
                sessionDefault: SESSION_DEFAULT,
                parentActiveModel: { providerID: 'p', modelID: 'm' },
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'p', modelID: 'm' });
        });

        it('preserves variantID when returning a roleConfig pattern that has one', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/vision' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: { vision: { providerID: 'v', modelID: 'vm', variantID: 'quantized' } },
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'v', modelID: 'vm', variantID: 'quantized' });
        });
    });

    describe('tier 3 — parentActiveModel', () => {
        it('returns parentActiveModel when agent.model is absent', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent(),
                sessionDefault: SESSION_DEFAULT,
                parentActiveModel: { providerID: 'p', modelID: 'm' },
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual({ providerID: 'p', modelID: 'm' });
        });
    });

    describe('tier 4 — sessionDefault (lowest)', () => {
        it('returns sessionDefault when all other tiers are absent', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent(),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual(SESSION_DEFAULT);
        });

        it('returns sessionDefault when alias misses and no parentActiveModel', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/slow' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual(SESSION_DEFAULT);
        });

        it('returns sessionDefault when mctrl/task is set with no parent', () => {
            const input: ResolveAgentModelInput = {
                agent: makeAgent({ model: 'mctrl/task' }),
                sessionDefault: SESSION_DEFAULT,
                roleConfig: {},
            };
            expect(resolveAgentModel(input)).toEqual(SESSION_DEFAULT);
        });
    });

    describe('DEFAULT_ROLE_CONFIG', () => {
        it('exports an empty role config so all roles start undefined', () => {
            expect(DEFAULT_ROLE_CONFIG).toEqual({});
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
            expect(DEFAULT_ROLE_CONFIG['slow']).toBeUndefined();
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forbids dot access
            expect(DEFAULT_ROLE_CONFIG['task']).toBeUndefined();
        });
    });
});
