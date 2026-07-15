// allow: SIZE_OK -- HEAD 437 -> current 484 pure LOC; one child-session authority and spawn state-machine regression matrix.
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentDefinition } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import type { ChildSpawnRequest } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { AgentIndex } from './agent-registry';
import { deriveChildPathPolicies, evaluatePathPolicies } from './path-policy-derive';
import type { ChildSpawnContext, SpawnFn } from './task-tool-runtime';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';

type Empty = Record<string, never>;

const emptySchema = z.object({}).strict();

function makeTool(name: string, capabilityClasses: readonly string[]): ToolRegistration<Empty, Empty> {
    return {
        name,
        description: `Mock tool ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
        inputSchema: emptySchema,
        outputSchema: emptySchema,
        outputLimit: { maxModelOutputChars: 1000 },
        execute: async () => ({}),
    };
}

function makeAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
        name: 'child-agent',
        description: 'Child test agent',
        systemPrompt: 'You are a child agent.',
        source: 'bundled',
        ...overrides,
    };
}

function makeParentAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
        name: 'parent',
        description: 'Parent agent',
        systemPrompt: 'You are the parent.',
        source: 'bundled',
        spawns: '*',
        ...overrides,
    };
}

function makeRequest(): ChildSpawnRequest {
    return {
        sessionId: 'sess-test-1',
        prompt: 'do the thing',
        loadSkills: [],
        childPermissions: [],
        subagentType: 'child-agent',
    };
}

interface BuildRuntimeOverrides {
    readonly childAgent?: AgentDefinition;
    readonly parentAgent?: AgentDefinition;
    readonly spawnFn?: SpawnFn;
}

function buildRuntime(overrides?: BuildRuntimeOverrides): {
    runtime: ConcreteTaskToolRuntime;
    captured: { context: ChildSpawnContext | undefined };
} {
    const child = overrides?.childAgent ?? makeAgent();
    const parent = overrides?.parentAgent ?? makeParentAgent();
    const agentIndex = new AgentIndex();
    agentIndex.register(child);

    const parentRegistry = new ToolRegistry();
    parentRegistry.register(makeTool('read', ['read']));
    parentRegistry.register(makeTool('command.run', ['bash']));
    parentRegistry.register(makeTool('task', ['subagent']));

    const captured: { context: ChildSpawnContext | undefined } = { context: undefined };

    const spawnFn: SpawnFn =
        overrides?.spawnFn ??
        (async (context) => {
            captured.context = context;
            return { sessionId: context.sessionId, status: 'completed', output: 'child output' };
        });

    const runtime = new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: parentRegistry,
        parentAgent: parent,
        spawnFn,
    });

    return { runtime, captured };
}

describe('ConcreteTaskToolRuntime', () => {
    describe('runChildSession', () => {
        it('(a) returns completed result when spawnFn succeeds for a valid agent', async () => {
            const { runtime } = buildRuntime();

            const result = await runtime.runChildSession(makeRequest());

            expect(result.status).toBe('completed');
            expect(result.sessionId).toBe('sess-test-1');
            expect(result.output).toBe('child output');
        });

        it('passes the resolved agent, model, system prompt, and tool registry to spawnFn', async () => {
            const { runtime, captured } = buildRuntime();

            await runtime.runChildSession(makeRequest());

            expect(captured.context).toBeDefined();
            expect(captured.context?.agent.name).toBe('child-agent');
            expect(captured.context?.model).toEqual({
                providerID: 'test-provider',
                modelID: 'child-agent',
            });
            expect(captured.context?.systemPrompt).toContain('You are a child agent.');
            expect(captured.context?.systemPrompt).toContain('delegated subagent');
        });

        it('(b) throws ToolExecutionError for unknown agent name', async () => {
            const { runtime } = buildRuntime();

            await expect(runtime.runChildSession({ ...makeRequest(), subagentType: 'ghost-agent' })).rejects.toThrow(
                ToolExecutionError,
            );
        });

        it('(b) error message contains the unknown agent name', async () => {
            const { runtime } = buildRuntime();

            await expect(runtime.runChildSession({ ...makeRequest(), subagentType: 'ghost-agent' })).rejects.toThrow(
                /ghost-agent/,
            );
        });

        it('throws when neither subagentType nor a matching category is provided', async () => {
            const { runtime } = buildRuntime();

            const request: ChildSpawnRequest = {
                sessionId: 'sess-test-1',
                prompt: 'do the thing',
                loadSkills: [],
                childPermissions: [],
            };

            await expect(runtime.runChildSession(request)).rejects.toThrow(ToolExecutionError);
        });

        it('(c) excludes tools denied by parent pathPolicies from the child tool surface', async () => {
            const { runtime, captured } = buildRuntime({
                parentAgent: makeParentAgent({
                    pathPolicies: [{ action: 'bash', resource: '**', effect: 'deny' }],
                }),
            });

            await runtime.runChildSession(makeRequest());

            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).not.toContain('command.run');
            expect(toolNames).not.toContain('task');
            expect(toolNames).toContain('read');
            expect(toolNames).toContain('yield');
        });

        it('(c) keeps bash tools when parent has no bash deny in pathPolicies', async () => {
            const { runtime, captured } = buildRuntime();

            await runtime.runChildSession(makeRequest());

            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).toContain('command.run');
        });

        it('forwards child pathPolicies allows before parent denies (last-match-wins)', async () => {
            const { runtime, captured } = buildRuntime({
                childAgent: makeAgent({
                    pathPolicies: [{ action: 'bash', resource: '**', effect: 'allow' }],
                }),
                parentAgent: makeParentAgent({
                    pathPolicies: [{ action: 'bash', resource: '**', effect: 'deny' }],
                }),
            });

            await runtime.runChildSession(makeRequest());

            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            // Parent deny appended AFTER child allow -> deny wins.
            expect(toolNames).not.toContain('command.run');
        });

        it('always adds the yield tool to the child surface', async () => {
            const { runtime, captured } = buildRuntime();

            await runtime.runChildSession(makeRequest());

            const yieldAd = captured.context?.childToolRegistry.advertise().find((a) => a.name === 'yield');
            expect(yieldAd).toBeDefined();
        });
    });

    describe('resumeChildSession', () => {
        it('delegates to spawnFn with the provided sessionId', async () => {
            const { runtime, captured } = buildRuntime();

            await runtime.runChildSession(makeRequest());
            const result = await runtime.resumeChildSession('sess-test-1', makeRequest());

            expect(result.status).toBe('completed');
            expect(captured.context?.sessionId).toBe('sess-test-1');
        });
    });

    describe('startBackgroundSession', () => {
        it('throws not-yet-implemented (AsyncJobManager is todo 23)', () => {
            const { runtime } = buildRuntime();

            expect(() => runtime.startBackgroundSession(makeRequest())).toThrow(/not yet implemented/);
        });
    });

    describe('sessionExists', () => {
        it('(e) returns false for an unknown session id', () => {
            const { runtime } = buildRuntime();

            expect(runtime.sessionExists('nonexistent-session')).toBe(false);
        });
    });

    describe('generateSessionId', () => {
        it('(d) returns unique session ids', () => {
            const { runtime } = buildRuntime();

            const id1 = runtime.generateSessionId();
            const id2 = runtime.generateSessionId();

            expect(id1).not.toBe(id2);
        });

        it('produces ids matching the session_<timestamp>_<hex> format', () => {
            const { runtime } = buildRuntime();

            const id = runtime.generateSessionId();

            expect(id).toMatch(/^session_\d+_[0-9a-f]{8}$/);
        });
    });

    describe('evaluatePathPolicies', () => {
        it('(e) returns deny when a matching deny rule exists', () => {
            const result = evaluatePathPolicies('edit', '/x', [{ action: 'edit', resource: '**', effect: 'deny' }]);

            expect(result.effect).toBe('deny');
        });

        it('(e) includes the matchedRule on a deny result', () => {
            const denyRule = { action: 'edit', resource: '**', effect: 'deny' as const };
            const result = evaluatePathPolicies('edit', '/x', [denyRule]);

            expect(result.matchedRule).toEqual(denyRule);
        });

        it('(f) returns ask (default) when no rule matches the action', () => {
            const result = evaluatePathPolicies('read', '/x', [{ action: 'edit', resource: '**', effect: 'deny' }]);

            expect(result.effect).toBe('ask');
            expect(result.matchedRule).toBeUndefined();
        });

        it('returns ask when rules list is empty', () => {
            const result = evaluatePathPolicies('edit', '/x', []);

            expect(result.effect).toBe('ask');
        });

        it('returns allow when a matching allow rule exists', () => {
            const result = evaluatePathPolicies('read', '/src/app.ts', [
                { action: 'read', resource: '**', effect: 'allow' },
            ]);

            expect(result.effect).toBe('allow');
        });

        it('uses last-match-wins when multiple rules match', () => {
            const result = evaluatePathPolicies('edit', '/x', [
                { action: 'edit', resource: '**', effect: 'allow' },
                { action: 'edit', resource: '**', effect: 'deny' },
            ]);

            expect(result.effect).toBe('deny');
        });
    });

    describe('deriveChildPathPolicies', () => {
        it('(g) forwards parent deny rules to the child', () => {
            const parent = makeParentAgent({
                pathPolicies: [{ action: 'bash', resource: '**', effect: 'deny' }],
            });
            const child = makeAgent();

            const result = deriveChildPathPolicies(parent, child);

            expect(result).toContainEqual({ action: 'bash', resource: '**', effect: 'deny' });
        });

        it('(g) does not forward parent allow rules', () => {
            const parent = makeParentAgent({
                pathPolicies: [
                    { action: 'read', resource: '**', effect: 'allow' },
                    { action: 'bash', resource: '**', effect: 'deny' },
                ],
            });
            const child = makeAgent();

            const result = deriveChildPathPolicies(parent, child);

            expect(result).toContainEqual({ action: 'bash', resource: '**', effect: 'deny' });
            expect(result).not.toContainEqual({ action: 'read', resource: '**', effect: 'allow' });
        });

        it('(g) preserves child policies before parent denies', () => {
            const child = makeAgent({
                pathPolicies: [{ action: 'write', resource: '.omo/**', effect: 'allow' }],
            });
            const parent = makeParentAgent({
                pathPolicies: [{ action: 'bash', resource: '**', effect: 'deny' }],
            });

            const result = deriveChildPathPolicies(parent, child);

            expect(result[0]).toEqual({ action: 'write', resource: '.omo/**', effect: 'allow' });
            expect(result[1]).toEqual({ action: 'bash', resource: '**', effect: 'deny' });
        });

        it('returns only child policies when parent has no pathPolicies', () => {
            const child = makeAgent({
                pathPolicies: [{ action: 'read', resource: '**', effect: 'allow' }],
            });
            const parent = makeParentAgent();

            const result = deriveChildPathPolicies(parent, child);

            expect(result).toEqual([{ action: 'read', resource: '**', effect: 'allow' }]);
        });

        it('returns empty array when neither parent nor child has pathPolicies', () => {
            const result = deriveChildPathPolicies(makeParentAgent(), makeAgent());

            expect(result).toEqual([]);
        });
    });

    describe('buildChildToolSurface hard capability filtering', () => {
        function buildRuntimeWithCapabilityTools(): {
            runtime: ConcreteTaskToolRuntime;
            captured: { context: ChildSpawnContext | undefined };
        } {
            const child = makeAgent();
            const parent = makeParentAgent();
            const agentIndex = new AgentIndex();
            agentIndex.register(child);

            const parentRegistry = new ToolRegistry();
            parentRegistry.register(makeTool('read', ['read']));
            parentRegistry.register(makeTool('command.run', ['bash']));
            parentRegistry.register(makeTool('task', ['subagent']));
            parentRegistry.register(makeTool('workflow', ['workflow']));
            parentRegistry.register(makeTool('webfetch', ['network']));
            parentRegistry.register(makeTool('spawn-helper', ['subagent']));

            const captured: { context: ChildSpawnContext | undefined } = { context: undefined };
            const spawnFn: SpawnFn = async (context) => {
                captured.context = context;
                return { sessionId: context.sessionId, status: 'completed', output: '' };
            };

            const runtime = new ConcreteTaskToolRuntime({
                agentIndex,
                resolveModel: (agent) => ({ providerID: 'test', modelID: agent.name }),
                workspaceRoot: '/tmp/workspace',
                parentToolRegistry: parentRegistry,
                parentAgent: parent,
                spawnFn,
            });
            return { runtime, captured };
        }

        it('drops workflow-capability tools from the child surface', async () => {
            const { runtime, captured } = buildRuntimeWithCapabilityTools();
            await runtime.runChildSession(makeRequest());
            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).not.toContain('workflow');
        });

        it('drops network-capability tools from the child surface', async () => {
            const { runtime, captured } = buildRuntimeWithCapabilityTools();
            await runtime.runChildSession(makeRequest());
            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).not.toContain('webfetch');
        });

        it('drops subagent-capability tools beyond task from the child surface', async () => {
            const { runtime, captured } = buildRuntimeWithCapabilityTools();
            await runtime.runChildSession(makeRequest());
            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).not.toContain('spawn-helper');
        });

        it('keeps read and bash tools (policy-controlled, not hard-dropped)', async () => {
            const { runtime, captured } = buildRuntimeWithCapabilityTools();
            await runtime.runChildSession(makeRequest());
            const toolNames = captured.context?.childToolRegistry.advertise().map((a) => a.name);
            expect(toolNames).toContain('read');
            expect(toolNames).toContain('command.run');
            expect(toolNames).toContain('yield');
        });
    });

    describe('default spawn fn (matrix row 7)', () => {
        function buildUsage() {
            return {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            };
        }

        function textOnlyChunks(text: string): LanguageModelV3StreamPart[] {
            return [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: text },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
            ];
        }

        function yieldCallChunks(result: string): LanguageModelV3StreamPart[] {
            const payload = JSON.stringify({ result });
            return [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-input-start', id: 'call_y', toolName: 'yield' },
                { type: 'tool-input-delta', id: 'call_y', delta: payload },
                { type: 'tool-input-end', id: 'call_y' },
                { type: 'tool-call', toolCallId: 'call_y', toolName: 'yield', input: payload },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
            ];
        }

        function buildDefaultSpawnRuntime(
            modelCallCount: { value: number },
            chunksFor: (call: number) => LanguageModelV3StreamPart[],
            summaryLimit?: number,
            knownCredential?: string,
        ): ConcreteTaskToolRuntime {
            const child = makeAgent({ systemPrompt: 'You are a deep coding agent. Explore, decide, act.' });
            const parent = makeParentAgent();
            const agentIndex = new AgentIndex();
            agentIndex.register(child);

            const parentRegistry = new ToolRegistry();
            parentRegistry.register(makeTool('read', ['read']));

            const mockModel = new MockLanguageModelV3({
                provider: 'test',
                modelId: 'mock',
                doStream: async () => {
                    modelCallCount.value += 1;
                    return { stream: convertArrayToReadableStream(chunksFor(modelCallCount.value)) };
                },
            });

            return new ConcreteTaskToolRuntime({
                agentIndex,
                resolveModel: (agent) => ({ providerID: 'test', modelID: agent.name }),
                workspaceRoot: '/tmp/workspace',
                parentToolRegistry: parentRegistry,
                parentAgent: parent,
                resolveSdkModel: () => mockModel,
                ...(summaryLimit !== undefined ? { summaryLimit } : {}),
                ...(knownCredential !== undefined
                    ? {
                          hostCallbacks: {
                              observabilityRedactor: createObservabilityRedactor({ secrets: [knownCredential] }),
                          },
                      }
                    : {}),
            });
        }

        it('returns failed salvage when resolveSdkModel is provided without a yield', async () => {
            const callCount = { value: 0 };
            const runtime = buildDefaultSpawnRuntime(callCount, () => textOnlyChunks('child completed'));

            const result = await runtime.runChildSession(makeRequest());

            expect(result.status).toBe('failed');
            expect(result.sessionId).toBe('sess-test-1');
            expect(result.output).toMatch(/^\[degraded salvage\] /);
            expect(result.output).toContain('child completed');
        });

        it('returns the yielded result when the child calls yield', async () => {
            const callCount = { value: 0 };
            const runtime = buildDefaultSpawnRuntime(callCount, (call) =>
                call === 1 ? yieldCallChunks('yielded payload') : textOnlyChunks('acknowledged'),
            );

            const result = await runtime.runChildSession(makeRequest());

            expect(result.status).toBe('completed');
            expect(result.output).toBe('yielded payload');
        });

        it('rejects when neither spawnFn nor resolveSdkModel is provided', async () => {
            const child = makeAgent();
            const agentIndex = new AgentIndex();
            agentIndex.register(child);
            const parentRegistry = new ToolRegistry();
            parentRegistry.register(makeTool('read', ['read']));

            const runtime = new ConcreteTaskToolRuntime({
                agentIndex,
                resolveModel: (agent) => ({ providerID: 'test', modelID: agent.name }),
                workspaceRoot: '/tmp/workspace',
                parentToolRegistry: parentRegistry,
                parentAgent: makeParentAgent(),
            });

            await expect(runtime.runChildSession(makeRequest())).rejects.toThrow(/spawnFn not wired/);
        });

        it('marks a child without yield as failed while salvaging the final assistant text', async () => {
            const callCount = { value: 0 };
            const runtime = buildDefaultSpawnRuntime(callCount, () => textOnlyChunks('x'.repeat(200)), 64);

            const result = await runtime.runChildSession({
                ...makeRequest(),
                prompt: 'explore the codebase',
            });

            expect(callCount.value).toBeGreaterThanOrEqual(1);
            expect(result.status).toBe('failed');
            expect(result.output).toMatch(/^\[degraded salvage\] /);
            expect(result.output.length).toBeLessThanOrEqual(64);
        });

        it('redacts credentials from degraded child salvage output', async () => {
            // Given
            const knownCredential = ['known', 'degraded', 'child', 'credential'].join('_');
            const callCount = { value: 0 };
            const runtime = buildDefaultSpawnRuntime(
                callCount,
                () => textOnlyChunks(`keep-this-salvage ${knownCredential}`),
                undefined,
                knownCredential,
            );

            // When
            const result = await runtime.runChildSession(makeRequest());

            // Then
            expect(result.status).toBe('failed');
            expect(result.output).toContain('keep-this-salvage');
            expect(result.output).toContain('[REDACTED_CREDENTIAL]');
            expect(result.output).not.toContain(knownCredential);
        });

        it('redacts credentials from yielded child output', async () => {
            // Given
            const knownCredential = ['known', 'yielded', 'child', 'credential'].join('_');
            const yieldedValue = `keep-this-yield ${knownCredential}`;
            const callCount = { value: 0 };
            const runtime = buildDefaultSpawnRuntime(
                callCount,
                (call) => (call === 1 ? yieldCallChunks(yieldedValue) : textOnlyChunks('acknowledged')),
                undefined,
                knownCredential,
            );

            // When
            const result = await runtime.runChildSession(makeRequest());

            // Then
            expect(result.status).toBe('completed');
            expect(result.output).toContain('keep-this-yield');
            expect(result.output).toContain('[REDACTED_CREDENTIAL]');
            expect(result.output).not.toContain(knownCredential);
        });
    });
});
