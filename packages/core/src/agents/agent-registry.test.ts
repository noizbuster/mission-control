import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { DiscoverAgentsResult } from './agent-loader.js';
import { AgentIndex } from './agent-registry.js';

function makeAgent(name: string, overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: `prompt for ${name}`,
        source: 'project',
        ...overrides,
    };
}

describe('AgentIndex', () => {
    it('registers distinct-name agents and preserves insertion order', () => {
        const index = new AgentIndex();
        index.register(makeAgent('alpha'));
        index.register(makeAgent('beta'));
        index.register(makeAgent('gamma'));

        expect(index.list()).toHaveLength(3);
        expect([...index.names()]).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('lookup returns the registered definition for a known name', () => {
        const index = new AgentIndex();
        const agent = makeAgent('known');
        index.register(agent);

        expect(index.lookup('known')).toBe(agent);
    });

    it('lookup returns undefined for an unknown name', () => {
        const index = new AgentIndex();

        expect(index.lookup('unknown')).toBeUndefined();
    });

    it('keeps the first registration on a duplicate name and records a diagnostic', () => {
        const index = new AgentIndex();
        const first = makeAgent('dup', { description: 'first' });
        const second = makeAgent('dup', { description: 'second' });

        index.register(first);
        index.register(second);

        const sameName = index.list().filter((agent) => agent.name === 'dup');
        expect(sameName).toHaveLength(1);
        expect(index.lookup('dup')).toBe(first);

        expect(index.diagnostics).toHaveLength(1);
        const diagnostic = index.diagnostics[0];
        expect(diagnostic?.code).toBe('duplicate_name');
        expect(diagnostic?.agentName).toBe('dup');
    });

    it('list returns a fresh readonly snapshot in insertion order', () => {
        const index = new AgentIndex();
        const a = makeAgent('a');
        const b = makeAgent('b');
        index.register(a);
        index.register(b);

        expect(index.list()).toEqual([a, b]);
        expect(index.list()).not.toBe(index.list());
    });

    it('names returns a fresh readonly string array in insertion order', () => {
        const index = new AgentIndex();
        index.register(makeAgent('first'));
        index.register(makeAgent('second'));

        expect([...index.names()]).toEqual(['first', 'second']);
        expect(index.names()).not.toBe(index.names());
    });

    it('initializes from a discovery result, copying agents and diagnostics', () => {
        const result: DiscoverAgentsResult = {
            agents: [makeAgent('one'), makeAgent('two')],
            diagnostics: [
                {
                    agentName: 'broken',
                    severity: 'error',
                    code: 'parse_error',
                    message: 'bad yaml',
                    path: '/agents/broken.md',
                },
            ],
        };

        const index = new AgentIndex(result);

        expect([...index.names()]).toEqual(['one', 'two']);
        expect(index.list()).toHaveLength(2);
        expect(index.diagnostics).toHaveLength(1);
        expect(index.diagnostics[0]?.code).toBe('parse_error');
    });

    it('reports duplicates handed in via the discovery result', () => {
        const result: DiscoverAgentsResult = {
            agents: [makeAgent('same'), makeAgent('same', { description: 'second' })],
            diagnostics: [],
        };

        const index = new AgentIndex(result);

        expect([...index.names()]).toEqual(['same']);
        expect(index.list()).toHaveLength(1);
        expect(index.diagnostics).toHaveLength(1);
        expect(index.diagnostics[0]?.code).toBe('duplicate_name');
    });

    it('starts empty when constructed with no discovery result', () => {
        const index = new AgentIndex();

        expect(index.list()).toHaveLength(0);
        expect(index.names()).toHaveLength(0);
        expect(index.diagnostics).toHaveLength(0);
    });
});
