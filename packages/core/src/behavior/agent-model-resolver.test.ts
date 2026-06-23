import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { resolveGraphAgentModels, type AgentModelLookup } from './agent-model-resolver.js';

const baseGraph: AbgGraphSpec = {
    id: 'test',
    entryNodeId: 'a',
    nodes: [
        { id: 'a', kind: 'llm' },
        { id: 'b', kind: 'llm' },
    ],
    edges: [],
    rules: [],
    policies: [],
};

const lookup: AgentModelLookup = (name) => {
    const map: Record<string, AbgNodeModelOptions> = {
        quick: { providerID: 'anthropic', modelID: 'claude-haiku' },
        deep: { providerID: 'anthropic', modelID: 'claude-sonnet' },
    };
    return map[name];
};

describe('resolveGraphAgentModels', () => {
    it('returns the original graph when no agent refs exist', () => {
        const result = resolveGraphAgentModels(baseGraph, lookup);
        expect(result).toBe(baseGraph);
    });

    it('resolves a node agent ref into node.model', () => {
        const graph: AbgGraphSpec = {
            ...baseGraph,
            nodes: [{ id: 'a', kind: 'llm', agent: 'quick' }],
        };
        const result = resolveGraphAgentModels(graph, lookup);
        expect(result.nodes[0]?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku' });
    });

    it('does not overwrite an explicit node.model', () => {
        const explicit: AbgNodeModelOptions = { providerID: 'openai', modelID: 'gpt-4' };
        const graph: AbgGraphSpec = {
            ...baseGraph,
            nodes: [{ id: 'a', kind: 'llm', agent: 'quick', model: explicit }],
        };
        const result = resolveGraphAgentModels(graph, lookup);
        expect(result.nodes[0]?.model).toBe(explicit);
    });

    it('resolves a defaults.agent ref into defaults.model', () => {
        const graph: AbgGraphSpec = {
            ...baseGraph,
            defaults: { agent: 'deep' },
        };
        const result = resolveGraphAgentModels(graph, lookup);
        expect(result.defaults?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet' });
    });

    it('leaves agent ref unresolved when lookup returns undefined', () => {
        const graph: AbgGraphSpec = {
            ...baseGraph,
            nodes: [{ id: 'a', kind: 'llm', agent: 'nonexistent' }],
        };
        const result = resolveGraphAgentModels(graph, lookup);
        expect(result.nodes[0]?.model).toBeUndefined();
    });

    it('resolves multiple nodes in one pass', () => {
        const graph: AbgGraphSpec = {
            ...baseGraph,
            nodes: [
                { id: 'a', kind: 'llm', agent: 'quick' },
                { id: 'b', kind: 'llm', agent: 'deep' },
            ],
        };
        const result = resolveGraphAgentModels(graph, lookup);
        expect(result.nodes[0]?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku' });
        expect(result.nodes[1]?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet' });
    });
});
