import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { DiscoverAgentsResult } from '../agent-loader.js';
import { CapabilityRegistry } from './index.js';
import type { AgentPluginProvider, LoadContext } from './types.js';

const CTX: LoadContext = { workspaceRoot: '/ws', userConfigDir: '/cfg' };

function makeAgent(name: string, overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: `prompt for ${name}`,
        source: 'plugin',
        ...overrides,
    };
}

function staticProvider(id: string, priority: number, agents: readonly AgentDefinition[]): AgentPluginProvider {
    return {
        id,
        displayName: id,
        description: `${id} provider`,
        priority,
        async loadAgents() {
            return agents;
        },
    };
}

describe('CapabilityRegistry', () => {
    it('resolves same-name conflicts in favor of the higher-priority provider', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('high', 100, [makeAgent('shared', { description: 'from-high' })]));
        registry.registerProvider(staticProvider('low', 50, [makeAgent('shared', { description: 'from-low' })]));

        const result = await registry.loadAll(CTX);

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]?.description).toBe('from-high');

        const dups = result.diagnostics.filter((d) => d.code === 'duplicate_name');
        expect(dups).toHaveLength(1);
        expect(dups[0]?.agentName).toBe('shared');
    });

    it('skips a disabled provider entirely', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('kept', 100, [makeAgent('alpha')]));
        registry.registerProvider(staticProvider('dropped', 100, [makeAgent('beta')]));
        registry.disableProvider('dropped');

        const result = await registry.loadAll(CTX);

        expect(result.agents.map((a) => a.name)).toEqual(['alpha']);
    });

    it('records a provider_error diagnostic and continues when a provider rejects', async () => {
        const registry = new CapabilityRegistry();
        const failing: AgentPluginProvider = {
            id: 'broken',
            displayName: 'broken',
            description: 'always fails',
            priority: 100,
            async loadAgents() {
                throw new Error('boom');
            },
        };
        registry.registerProvider(failing);
        registry.registerProvider(staticProvider('ok', 50, [makeAgent('gamma')]));

        const result = await registry.loadAll(CTX);

        expect(result.agents.map((a) => a.name)).toEqual(['gamma']);
        const errors = result.diagnostics.filter((d) => d.code === 'provider_error');
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toContain('boom');
        expect(errors[0]?.message).toContain('broken');
    });

    it('merges agents from three providers with distinct names in priority order', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('a', 100, [makeAgent('one')]));
        registry.registerProvider(staticProvider('b', 50, [makeAgent('two')]));
        registry.registerProvider(staticProvider('c', 1, [makeAgent('three')]));

        const result = await registry.loadAll(CTX);

        expect(result.agents.map((a) => a.name)).toEqual(['one', 'two', 'three']);
    });

    it('returns a result assignable to DiscoverAgentsResult', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('only', 100, [makeAgent('solo')]));

        const result: DiscoverAgentsResult = await registry.loadAll(CTX);

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]?.name).toBe('solo');
        expect(Array.isArray(result.diagnostics)).toBe(true);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('resolves a three-way name conflict so priority 100 beats 50 and 1', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('primary', 100, [makeAgent('tri', { description: 'p100' })]));
        registry.registerProvider(staticProvider('standard', 50, [makeAgent('tri', { description: 'p50' })]));
        registry.registerProvider(staticProvider('legacy', 1, [makeAgent('tri', { description: 'p1' })]));

        const result = await registry.loadAll(CTX);

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]?.description).toBe('p100');
        const dups = result.diagnostics.filter((d) => d.code === 'duplicate_name');
        expect(dups).toHaveLength(2);
    });

    it('re-enables a previously disabled provider on the next loadAll', async () => {
        const registry = new CapabilityRegistry();
        registry.registerProvider(staticProvider('toggle', 100, [makeAgent('alpha')]));
        registry.disableProvider('toggle');

        const disabled = await registry.loadAll(CTX);
        expect(disabled.agents).toHaveLength(0);

        registry.enableProvider('toggle');
        const enabled = await registry.loadAll(CTX);
        expect(enabled.agents.map((a) => a.name)).toEqual(['alpha']);
    });
});
