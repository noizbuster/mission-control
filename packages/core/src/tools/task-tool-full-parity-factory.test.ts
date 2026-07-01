/**
 * Stub-closure tests for the full-parity task tool's model-resolution logic.
 *
 * The override is INERT at spawn until todo 25 wires the real graph runner
 * (the factory's `spawnFn` calls `spawnChildCodingAgent`; the runtime's default
 * `spawnFn` rejects with `spawnFn not wired`). End-to-end spawn observability
 * therefore lands with todo 25. Until then, this suite drives the extracted
 * {@linkcode buildResolveModelFn} closure directly — the same closure the
 * factory passes into `ConcreteTaskToolRuntime` — to prove the
 * override / skip-task-guard / fallthrough precedence.
 */

import type { AbgNodeModelOptions, AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ModelPattern } from '../agents/model-resolver.js';
import { buildResolveModelFn } from './task-tool-full-parity-factory.js';

const parentModel: AbgNodeModelOptions = { providerID: 'local', modelID: 'local-echo' };
const parentModelWithVariant: AbgNodeModelOptions = {
    providerID: 'local',
    modelID: 'local-echo',
    variantID: 'default',
};

function agent(name: string, model: AgentDefinition['model']): AgentDefinition {
    return {
        name,
        description: `${name} test agent`,
        systemPrompt: '',
        source: 'bundled',
        ...(model !== undefined ? { model } : {}),
    };
}

describe('buildResolveModelFn', () => {
    it('returns the stored override ModelPattern for a named agent', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['oracle', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('oracle', 'mctrl/slow'));
        // Then
        expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
    });

    it('returns a variant-bearing override unchanged', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['explore', { providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('explore', 'mctrl/smol'));
        // Then
        expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' });
    });

    it('skips the override for a mctrl/task-role agent and inherits the parent model', () => {
        // Given: an override exists for the task agent's name, but its role is task
        const overrides = new Map<string, ModelPattern>([
            ['runner', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('runner', 'mctrl/task'));
        // Then: the task-role invariant wins over the override
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
    });

    it('does not apply the override when the agent name is absent', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['oracle', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('someone-else', 'mctrl/slow'));
        // Then
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
    });

    it('falls through to the parent model when no overrides are configured', () => {
        // Given
        const resolveModel = buildResolveModelFn({ model: parentModel });
        // When
        const result = resolveModel(agent('oracle', 'mctrl/slow'));
        // Then
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
    });

    it('falls through to the parent model when the overrides map is empty', () => {
        // Given
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: new Map() });
        // When
        const result = resolveModel(agent('oracle', 'mctrl/slow'));
        // Then
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
    });

    it('preserves the parent variantID on fallthrough', () => {
        // Given
        const resolveModel = buildResolveModelFn({
            model: parentModelWithVariant,
            agentModelOverrides: new Map(),
        });
        // When
        const result = resolveModel(agent('oracle', 'mctrl/slow'));
        // Then
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo', variantID: 'default' });
    });

    it('preserves the parent variantID on task-role skip', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['runner', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({
            model: parentModelWithVariant,
            agentModelOverrides: overrides,
        });
        // When
        const result = resolveModel(agent('runner', 'mctrl/task'));
        // Then
        expect(result).toEqual({ providerID: 'local', modelID: 'local-echo', variantID: 'default' });
    });

    it('treats an agent with a concrete object model (not mctrl/task) as overridable', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['oracle', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('oracle', { providerID: 'openai', modelID: 'gpt-4o' }));
        // Then: object models are concrete, not task aliases, so the override applies
        expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
    });

    it('does not treat a non-task mctrl alias as a skip', () => {
        // Given
        const overrides = new Map<string, ModelPattern>([
            ['planner', { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }],
        ]);
        const resolveModel = buildResolveModelFn({ model: parentModel, agentModelOverrides: overrides });
        // When
        const result = resolveModel(agent('planner', 'mctrl/plan'));
        // Then: only mctrl/task skips; mctrl/plan is overridable
        expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
    });
});
