import { describe, expect, it } from 'vitest';
import {
    AGENT_SOURCES,
    AGENT_TIERS,
    AGENT_THINKING_LEVELS,
    AgentDefinitionSchema,
    AgentListSchema,
    AgentSourceSchema,
    AgentThinkingLevelSchema,
    AgentTierSchema,
    type AgentDefinition,
} from './agent.js';

const minimalValid: AgentDefinition = {
    name: 'researcher',
    description: 'A read-only research agent.',
    systemPrompt: 'You are a research agent.',
    source: 'bundled',
};

describe('AgentSourceSchema', () => {
    it('accepts each declared source value', () => {
        for (const source of AGENT_SOURCES) {
            expect(AgentSourceSchema.parse(source)).toBe(source);
        }
    });

    it('rejects an unknown source value', () => {
        expect(() => AgentSourceSchema.parse('cloud')).toThrow();
    });
});

describe('AgentTierSchema', () => {
    it('accepts each declared tier value', () => {
        for (const tier of AGENT_TIERS) {
            expect(AgentTierSchema.parse(tier)).toBe(tier);
        }
    });

    it('rejects an unknown tier value', () => {
        expect(() => AgentTierSchema.parse('admin')).toThrow();
    });
});

describe('AgentThinkingLevelSchema', () => {
    it('accepts each declared thinking level', () => {
        for (const level of AGENT_THINKING_LEVELS) {
            expect(AgentThinkingLevelSchema.parse(level)).toBe(level);
        }
    });
});

describe('AgentDefinitionSchema', () => {
    it('parses a minimal valid agent (name, description, systemPrompt, source)', () => {
        const agent = AgentDefinitionSchema.parse(minimalValid);
        expect(agent.name).toBe('researcher');
        expect(agent.source).toBe('bundled');
        expect(agent.tools).toBeUndefined();
        expect(agent.pathPolicies).toBeUndefined();
    });

    it('rejects an agent missing the systemPrompt field', () => {
        expect(() =>
            AgentDefinitionSchema.parse({
                name: 'researcher',
                description: 'A research agent.',
                source: 'bundled',
            }),
        ).toThrow();
    });

    it('rejects an agent missing the name field', () => {
        expect(() =>
            AgentDefinitionSchema.parse({
                description: 'A research agent.',
                systemPrompt: 'You are a research agent.',
                source: 'bundled',
            }),
        ).toThrow();
    });

    it('rejects an agent missing the description field', () => {
        expect(() =>
            AgentDefinitionSchema.parse({
                name: 'researcher',
                systemPrompt: 'You are a research agent.',
                source: 'bundled',
            }),
        ).toThrow();
    });

    it('rejects an agent missing the source field', () => {
        expect(() =>
            AgentDefinitionSchema.parse({
                name: 'researcher',
                description: 'A research agent.',
                systemPrompt: 'You are a research agent.',
            }),
        ).toThrow();
    });

    it('rejects an empty name', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, name: '' })).toThrow();
    });

    it('rejects an empty description', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, description: '' })).toThrow();
    });

    it('rejects an unknown top-level field (strict mode)', () => {
        expect(() =>
            AgentDefinitionSchema.parse({ ...minimalValid, permissions: ['read'] }),
        ).toThrow();
    });

    it('parses pathPolicies with valid PolicyEffectRule entries', () => {
        const agent = AgentDefinitionSchema.parse({
            ...minimalValid,
            pathPolicies: [
                { action: 'edit', resource: 'src/**', effect: 'allow' },
                { action: 'write', resource: '**', effect: 'deny' },
            ],
        });
        expect(agent.pathPolicies).toHaveLength(2);
        expect(agent.pathPolicies?.[0]?.effect).toBe('allow');
    });

    it('parses tools as a string array', () => {
        const agent = AgentDefinitionSchema.parse({
            ...minimalValid,
            tools: ['read', 'ls', 'grep'],
        });
        expect(agent.tools).toEqual(['read', 'ls', 'grep']);
    });

    it('parses spawns as the "*" wildcard literal', () => {
        const agent = AgentDefinitionSchema.parse({ ...minimalValid, spawns: '*' });
        expect(agent.spawns).toBe('*');
    });

    it('parses spawns as a string array', () => {
        const agent = AgentDefinitionSchema.parse({
            ...minimalValid,
            spawns: ['researcher', 'planner'],
        });
        expect(agent.spawns).toEqual(['researcher', 'planner']);
    });

    it('parses model as a string alias', () => {
        const agent = AgentDefinitionSchema.parse({ ...minimalValid, model: 'opus' });
        expect(agent.model).toBe('opus');
    });

    it('parses model as a providerID/modelID object', () => {
        const agent = AgentDefinitionSchema.parse({
            ...minimalValid,
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        });
        expect(agent.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
    });

    it('rejects a model object missing modelID', () => {
        expect(() =>
            AgentDefinitionSchema.parse({ ...minimalValid, model: { providerID: 'anthropic' } }),
        ).toThrow();
    });

    it('rejects a model object with an unknown field (strict nested object)', () => {
        expect(() =>
            AgentDefinitionSchema.parse({
                ...minimalValid,
                model: { providerID: 'anthropic', modelID: 'x', variantID: 'v1' },
            }),
        ).toThrow();
    });

    it('parses tier as each valid enum value', () => {
        for (const tier of AGENT_TIERS) {
            const agent = AgentDefinitionSchema.parse({ ...minimalValid, tier });
            expect(agent.tier).toBe(tier);
        }
    });

    it('rejects an unknown tier value', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, tier: 'admin' })).toThrow();
    });

    it('parses source as each valid enum value', () => {
        for (const source of AGENT_SOURCES) {
            const agent = AgentDefinitionSchema.parse({ ...minimalValid, source });
            expect(agent.source).toBe(source);
        }
    });

    it('rejects an unknown source value', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, source: 'cloud' })).toThrow();
    });

    it('parses thinkingLevel as a valid enum value', () => {
        const agent = AgentDefinitionSchema.parse({ ...minimalValid, thinkingLevel: 'high' });
        expect(agent.thinkingLevel).toBe('high');
    });

    it('parses recursion as -1 (unlimited) and as a non-negative int', () => {
        expect(AgentDefinitionSchema.parse({ ...minimalValid, recursion: -1 }).recursion).toBe(-1);
        expect(AgentDefinitionSchema.parse({ ...minimalValid, recursion: 0 }).recursion).toBe(0);
        expect(AgentDefinitionSchema.parse({ ...minimalValid, recursion: 5 }).recursion).toBe(5);
    });

    it('rejects recursion of -2', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, recursion: -2 })).toThrow();
    });

    it('parses maxTurns as a positive integer', () => {
        expect(AgentDefinitionSchema.parse({ ...minimalValid, maxTurns: 10 }).maxTurns).toBe(10);
    });

    it('rejects maxTurns of zero or a negative value', () => {
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, maxTurns: 0 })).toThrow();
        expect(() => AgentDefinitionSchema.parse({ ...minimalValid, maxTurns: -1 })).toThrow();
    });

    it('parses the remaining optional metadata fields', () => {
        const agent = AgentDefinitionSchema.parse({
            ...minimalValid,
            filePath: '/agents/researcher.json',
            disabled: true,
            role: 'specialist',
            color: '#ff0000',
            blocking: true,
            autoloadSkills: ['impeccable'],
            readSummarize: false,
            output: { format: 'json' },
        });
        expect(agent.filePath).toBe('/agents/researcher.json');
        expect(agent.disabled).toBe(true);
        expect(agent.role).toBe('specialist');
        expect(agent.color).toBe('#ff0000');
        expect(agent.blocking).toBe(true);
        expect(agent.autoloadSkills).toEqual(['impeccable']);
        expect(agent.readSummarize).toBe(false);
        expect(agent.output).toEqual({ format: 'json' });
    });
});

describe('AgentListSchema', () => {
    it('parses an array of agent definitions', () => {
        const list = AgentListSchema.parse([minimalValid, { ...minimalValid, name: 'planner' }]);
        expect(list).toHaveLength(2);
        expect(list[0]?.name).toBe('researcher');
        expect(list[1]?.name).toBe('planner');
    });

    it('parses an empty array', () => {
        expect(AgentListSchema.parse([])).toEqual([]);
    });

    it('rejects an array containing an invalid agent', () => {
        expect(() => AgentListSchema.parse([{ description: 'no name' }])).toThrow();
    });
});
