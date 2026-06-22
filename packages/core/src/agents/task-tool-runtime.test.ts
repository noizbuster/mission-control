import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistration } from '../tools/tool-registry-types.js';
import { ToolExecutionError } from '../tools/tool-registry-types.js';
import { AgentIndex } from './agent-registry.js';
import { deriveChildPathPolicies, evaluatePathPolicies } from './path-policy-derive.js';
import type { ChildSpawnContext, SpawnFn } from './task-tool-runtime.js';
import { ConcreteTaskToolRuntime } from './task-tool-runtime.js';

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

            const result = await runtime.resumeChildSession('sess-resume-1', makeRequest());

            expect(result.status).toBe('completed');
            expect(captured.context?.sessionId).toBe('sess-resume-1');
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
});
