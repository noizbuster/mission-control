/**
 * Tests for the full-parity task tool: model-resolution closure + end-to-end spawn.
 *
 * The factory delegates child execution to `ConcreteTaskToolRuntime`'s default spawn
 * (built from `resolveSdkModel`). The model-resolution tests drive
 * {@linkcode buildResolveModelFn} directly; the spawn test exercises the full factory
 * path (permission gate → runtime → default spawn → graph runner → yield capture).
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type {
    AbgNodeModelOptions,
    AgentDefinition,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { ModelPattern } from '../agents/model-resolver';
import { makeTaskRuntimeServices } from '../agents/task-tool-runtime-background-test-support';
import { buildResolveModelFn, createFullParityTaskToolRegistrationForCli } from './task-tool-full-parity-factory';
import { ToolRegistry } from './tool-registry';

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

    describe('roleConfig routing (TODO #3 wiring)', () => {
        const roleConfig: Partial<Record<import('../agents/model-roles').ModelRole, ModelPattern>> = {
            slow: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        };

        it('resolves mctrl/<role> through roleConfig when the role is populated', () => {
            // Given
            const resolveModel = buildResolveModelFn({ model: parentModel, roleConfig });
            // When
            const result = resolveModel(agent('oracle', 'mctrl/slow'));
            // Then: roleConfig.slow wins
            expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
        });

        it('preserves the mctrl/task skip-guard over roleConfig at the factory level', () => {
            // Given: a roleConfig with a task entry that must NOT be consulted
            const taskRoleConfig: Partial<Record<import('../agents/model-roles').ModelRole, ModelPattern>> = {
                task: { providerID: 'should-not-be-used', modelID: 'no' },
            };
            const resolveModel = buildResolveModelFn({ model: parentModel, roleConfig: taskRoleConfig });
            // When
            const result = resolveModel(agent('runner', 'mctrl/task'));
            // Then: parent model returned, roleConfig.task ignored
            expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
        });

        it('falls through to the parent model when roleConfig is absent (byte-identical to pre-#3)', () => {
            // Given: no roleConfig option at all
            const resolveModel = buildResolveModelFn({ model: parentModel });
            // When
            const result = resolveModel(agent('oracle', 'mctrl/slow'));
            // Then: parent model, roleConfig tier never entered
            expect(result).toEqual({ providerID: 'local', modelID: 'local-echo' });
        });

        it('lets agentModelOverrides win for a named agent when roleConfig has no matching entry', () => {
            // Given
            const overrides = new Map<string, ModelPattern>([['oracle', { providerID: 'openai', modelID: 'gpt-5' }]]);
            const resolveModel = buildResolveModelFn({
                model: parentModel,
                agentModelOverrides: overrides,
                roleConfig,
            });
            // When: agent model is a string with no roleConfig entry (mctrl/vision absent)
            const result = resolveModel(agent('oracle', 'mctrl/vision'));
            // Then: override map wins for the named agent
            expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
        });
    });
});

describe('createFullParityTaskToolRegistrationForCli end-to-end spawn', () => {
    function buildUsage() {
        return {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
        };
    }

    function textChunks(text: string): LanguageModelV3StreamPart[] {
        return [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: text },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
        ];
    }

    function yieldChunks(result: string): LanguageModelV3StreamPart[] {
        const payload = JSON.stringify({ result });
        return [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-input-start', id: 'cy', toolName: 'yield' },
            { type: 'tool-input-delta', id: 'cy', delta: payload },
            { type: 'tool-input-end', id: 'cy' },
            { type: 'tool-call', toolCallId: 'cy', toolName: 'yield', input: payload },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
        ];
    }

    const allowAll: (request: PermissionRequest) => PermissionDecision = (request) => ({
        requestId: request.id,
        status: 'allow',
    });

    function buildFactoryOptions(
        callCount: { value: number },
        chunksFor: (call: number) => LanguageModelV3StreamPart[],
    ) {
        const mockModel = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => {
                callCount.value += 1;
                return { stream: convertArrayToReadableStream(chunksFor(callCount.value)) };
            },
        });
        const parentToolRegistry = new ToolRegistry();
        return {
            workspaceRoot: '/tmp/workspace',
            requestPermission: allowAll,
            resolveSdkModel: () => mockModel,
            model: parentModel,
            parentToolRegistry,
        };
    }

    it('spawns a bundled child agent via the default spawn and resolves with text output', async () => {
        const callCount = { value: 0 };
        const registration = await createFullParityTaskToolRegistrationForCli(
            buildFactoryOptions(callCount, (call) =>
                call === 1 ? yieldChunks('factory child done') : textChunks('done'),
            ),
        );

        const result = await registration.execute(
            { agent: 'deep', assignment: 'do the thing', load_skills: [] },
            { toolCallId: 'tc_1', toolName: 'task', signal: new AbortController().signal },
        );

        expect(result.status).toBe('completed');
        expect(result.output).toContain('factory child done');
    });

    it('returns the yielded result when the child calls yield', async () => {
        const callCount = { value: 0 };
        const registration = await createFullParityTaskToolRegistrationForCli(
            buildFactoryOptions(callCount, (call) =>
                call === 1 ? yieldChunks('factory yielded result') : textChunks('done'),
            ),
        );

        const result = await registration.execute(
            { agent: 'deep', assignment: 'do the thing', load_skills: [] },
            { toolCallId: 'tc_1', toolName: 'task', signal: new AbortController().signal },
        );

        expect(result.status).toBe('completed');
        expect(result.output).toBe('factory yielded result');
    });

    it('stamps the first child of a durable CLI root session at depth 1', async () => {
        // Given
        const callCount = { value: 0 };
        const services = makeTaskRuntimeServices();
        const registration = await createFullParityTaskToolRegistrationForCli({
            ...buildFactoryOptions(callCount, () => yieldChunks('durable root child done')),
            parentSessionId: 'durable-cli-root',
            isCliRootParent: true,
            services,
        });

        // When
        const result = await registration.execute(
            { agent: 'deep', assignment: 'do the thing', load_skills: [] },
            { toolCallId: 'tc_durable_root', toolName: 'task', signal: new AbortController().signal },
        );

        // Then
        expect(result.status).toBe('completed');
        expect(services.runtimeRegistry.lookup(result.sessionId)?.taskDepth).toBe(1);
    });
});
