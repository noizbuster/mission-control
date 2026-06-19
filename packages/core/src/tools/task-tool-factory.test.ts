import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TaskSpawnFn } from './task-tool.js';
import { createChildToolRegistry } from './task-tool.js';
import { createTaskSpawnFn, registerTaskTool, type TaskToolSpawnContext } from './task-tool-factory.js';
import { ToolRegistry } from './tool-registry.js';

const okSchema = z.object({ ok: z.boolean() });

function readTool(name: string) {
    return {
        name,
        description: `read tool ${name}`,
        capabilityClasses: ['read'],
        parametersJsonSchema: { type: 'object', additionalProperties: false },
        inputSchema: okSchema,
        outputSchema: okSchema,
        outputLimit: { maxModelOutputChars: 100 },
        execute: async () => ({ ok: true }),
    };
}

function toolWithCaps(name: string, capabilityClasses: readonly string[]) {
    return {
        name,
        description: `tool ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object', additionalProperties: false },
        inputSchema: okSchema,
        outputSchema: okSchema,
        outputLimit: { maxModelOutputChars: 100 },
        execute: async () => ({ ok: true }),
    };
}

describe('task self-gating factory (graph-path permission gate)', () => {
    it('calls requestPermission with kind subagent and surfaces approval_required when denied (no spawn)', async () => {
        const spawnCalls: { readonly description: string; readonly prompt: string }[] = [];
        const registry = await buildRegistry(
            (request) => {
                capturedRequest = request;
                return { requestId: request.id, status: 'requires_approval', reason: 'no automatic subagent' };
            },
            async (input) => {
                spawnCalls.push(input);
                return { description: input.description, status: 'completed', summary: 'child ran' };
            },
        );

        const settlement = await invokeTask(registry, 'summarize deps', 'find the deps');

        expect(capturedRequest?.permission?.kind).toBe('subagent');
        expect(capturedRequest?.action).toBe('task');
        expect(capturedRequest?.reason).toContain('summarize deps');
        expect(capturedRequest?.permission?.patterns).toContain('summarize deps');
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_required');
        expect(settlement.result.error?.message).toContain('no automatic subagent');
        expect(spawnCalls).toHaveLength(0);
    });

    it('surfaces approval_denied when the decision is deny (no spawn)', async () => {
        const spawnCalls: { readonly description: string; readonly prompt: string }[] = [];
        const registry = await buildRegistry(
            () => ({ requestId: 'permission_task_call', status: 'deny' as const, reason: 'operator denied' }),
            async (input) => {
                spawnCalls.push(input);
                return { description: input.description, status: 'completed', summary: 'x' };
            },
        );

        const settlement = await invokeTask(registry, 'denied task', 'do something');

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_denied');
        expect(spawnCalls).toHaveLength(0);
    });

    it('delegates to spawn after an allow decision', async () => {
        const spawnCalls: { readonly description: string; readonly prompt: string }[] = [];
        const registry = await buildRegistry(
            (request) => ({ requestId: request.id, status: 'allow' as const, reason: 'approved' }),
            async (input) => {
                spawnCalls.push(input);
                return { description: input.description, status: 'completed', summary: 'child summary' };
            },
        );

        const settlement = await invokeTask(registry, 'approved task', 'run it');

        expect(settlement.result.status).toBe('completed');
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0]).toEqual({ description: 'approved task', prompt: 'run it' });
        const output = settlement.structuredOutput as { readonly summary: string };
        expect(output.summary).toBe('child summary');
    });

    it('wraps a throwing spawn in a tool failure (approval already granted)', async () => {
        const registry = await buildRegistry(
            (request) => ({ requestId: request.id, status: 'allow' as const, reason: 'approved' }),
            async () => {
                throw new Error('child graph crashed');
            },
        );

        const settlement = await invokeTask(registry, 'crash task', 'go');

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('crash task');
        expect(settlement.result.error?.message).toContain('child graph crashed');
    });

    it('advertises the task tool with a guideline and subagent capability', async () => {
        const registry = await buildRegistry(
            () => ({ requestId: 'permission_task_call', status: 'allow' as const, reason: 'ok' }),
            async () => ({ description: 'd', status: 'completed', summary: 's' }),
        );
        const ad = registry.advertise().find((tool) => tool.name === 'task');
        expect(ad).toBeDefined();
        expect(ad?.guideline).toBeDefined();
        expect(ad?.capabilityClasses).toContain('subagent');
    });

    let capturedRequest: PermissionRequest | undefined;

    async function buildRegistry(
        decide: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>,
        spawn: TaskSpawnFn,
    ): Promise<ToolRegistry> {
        capturedRequest = undefined;
        const registry = new ToolRegistry();
        await registerTaskTool(registry, {
            workspaceRoot: '/workspace',
            requestPermission: (request) => {
                capturedRequest = request;
                return Promise.resolve(decide(request));
            },
            spawn,
        });
        return registry;
    }
});

describe('createTaskSpawnFn + child registry (network/subagent/destructive blocklist)', () => {
    it('a parent containing task/webfetch/mcp/shell yields a child with NONE of them', () => {
        const parent = new ToolRegistry();
        parent.register(readTool('repo.read'));
        parent.register(toolWithCaps('webfetch', ['network']));
        parent.register(toolWithCaps('mcp__srv__tool', ['network']));
        parent.register(toolWithCaps('mcp', ['network']));
        parent.register(toolWithCaps('shell', ['bash']));
        parent.register(toolWithCaps('task', ['subagent']));

        const child = createChildToolRegistry(parent);
        const names = child.advertise().map((tool) => tool.name);

        expect(names).toContain('repo.read');
        expect(names).not.toContain('webfetch');
        expect(names).not.toContain('mcp__srv__tool');
        expect(names).not.toContain('mcp');
        expect(names).not.toContain('shell');
        expect(names).not.toContain('task');
    });

    it('createTaskSpawnFn returns a spawn function that captures the parent registry for child-surface derivation', () => {
        const parent = new ToolRegistry();
        parent.register(readTool('repo.read'));
        const ctx: TaskToolSpawnContext = {
            resolveSdkModel: () => {
                throw new Error('not invoked here');
            },
            model: { providerID: 'local', modelID: 'echo' },
            parentToolRegistry: parent,
            parentSessionId: 'session_parent',
        };
        const spawn = createTaskSpawnFn(ctx);
        expect(typeof spawn).toBe('function');
    });
});

async function invokeTask(registry: ToolRegistry, description: string, prompt: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'task');
    if (advertisement === undefined) {
        throw new TypeError('task not registered');
    }
    return registry.invoke({
        toolCallId: 'task_call',
        toolName: 'task',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ description, prompt }),
    });
}
