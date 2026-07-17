import { describe, expect, it } from 'vitest';
import { fileWriteInputSchema } from '../tools/file-write-schemas';
import { createFullParityTaskToolRegistration } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { createChildToolInvocationPolicy } from './child-tool-permissions';
import {
    advertisedChildToolNames,
    allowAllChildPermissions,
    buildPermissionRuntime,
    makePermissionAgent,
    makePermissionRequest,
    toolOutputSchema,
} from './task-tool-runtime-permissions-test-support';

describe('ConcreteTaskToolRuntime child permission enforcement', () => {
    it('removes inherited denies after the deep category allow even when parent tools execute permissively', async () => {
        const parentAgent = makePermissionAgent({
            name: 'parent-agent',
            spawns: '*',
            pathPolicies: [
                { action: 'write', resource: '**', effect: 'deny' },
                { action: 'patch', resource: '**', effect: 'deny' },
                { action: 'bash', resource: '**', effect: 'deny' },
            ],
        });
        const { runtime, contexts } = buildPermissionRuntime(makePermissionAgent({ name: 'deep' }), parentAgent);
        const taskRegistry = new ToolRegistry();
        const taskAdvertisement = taskRegistry.register(createFullParityTaskToolRegistration({ runtime }));

        const result = await taskRegistry.invoke({
            toolCallId: 'call-task',
            toolName: 'task',
            advertisedVersion: taskAdvertisement.version,
            argumentsJson: JSON.stringify({ category: 'deep', prompt: 'perform the delegated task' }),
        });

        expect(result.result.status).toBe('completed');
        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('repo.read');
        expect(names).not.toContain('file.write');
        expect(names).not.toContain('file.patch');
        expect(names).not.toContain('bash.run');
    });

    it('keeps permitted parent tools while intersecting the agent allowlist and hard drops', async () => {
        const childAgent = makePermissionAgent({
            tools: ['repo.read', 'file.write', 'webfetch', 'local-cache', 'task', 'workflow', 'team_create'],
        });
        const { runtime, contexts } = buildPermissionRuntime(childAgent);

        await runtime.runChildSession(makePermissionRequest(allowAllChildPermissions));

        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('repo.read');
        expect(names).toContain('file.write');
        expect(names).toContain('local-cache');
        expect(names).toContain('yield');
        expect(names).not.toContain('file.patch');
        expect(names).not.toContain('bash.run');
        expect(names).not.toContain('webfetch');
        expect(names).not.toContain('task');
        expect(names).not.toContain('workflow');
        expect(names).not.toContain('team_create');
    });

    it('hard drops team and IRC subagent tools from child task surfaces', async () => {
        // Given
        const childAgent = makePermissionAgent({ tools: ['repo.read', 'team_create', 'irc'] });
        const { runtime, contexts } = buildPermissionRuntime(childAgent);

        // When
        await runtime.runChildSession(makePermissionRequest(allowAllChildPermissions));

        // Then
        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('repo.read');
        expect(names).not.toContain('team_create');
        expect(names).not.toContain('irc');
    });

    it('intersects category tool aliases with canonical production read tools', async () => {
        const { runtime, contexts } = buildPermissionRuntime(
            makePermissionAgent({ name: 'quick', tools: ['read', 'ls', 'grep', 'find'] }),
        );
        const taskRegistry = new ToolRegistry();
        const taskAdvertisement = taskRegistry.register(createFullParityTaskToolRegistration({ runtime }));

        const result = await taskRegistry.invoke({
            toolCallId: 'call-quick-task',
            toolName: 'task',
            advertisedVersion: taskAdvertisement.version,
            argumentsJson: JSON.stringify({ category: 'quick', prompt: 'inspect quickly' }),
        });

        expect(result.result.status).toBe('completed');
        const names = advertisedChildToolNames(contexts[0]);
        expect(names).toContain('repo.read');
        expect(names).not.toContain('file.write');
        expect(names).not.toContain('bash.run');
    });

    it('applies wildcard action denies to tools with unknown capability classes', async () => {
        const { runtime, contexts } = buildPermissionRuntime();

        await runtime.runChildSession(makePermissionRequest([{ action: '**', resource: '**', effect: 'deny' }]));

        expect(advertisedChildToolNames(contexts[0])).not.toContain('coordinate');
    });

    it('enforces resource-specific derived permissions when the retained tool is invoked', async () => {
        const { runtime, contexts, executed } = buildPermissionRuntime();
        await runtime.runChildSession(
            makePermissionRequest([
                { action: 'write', resource: '**', effect: 'deny' },
                { action: 'write', resource: 'allowed/**', effect: 'allow' },
            ]),
        );
        const registry = contexts[0]?.childToolRegistry;
        const advertisement = registry?.advertise().find((tool) => tool.name === 'file.write');
        expect(advertisement).toBeDefined();
        if (registry === undefined || advertisement === undefined) return;

        const denied = await registry.invoke({
            toolCallId: 'call-denied',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'blocked/file.ts', content: 'blocked' }),
        });
        const allowed = await registry.invoke({
            toolCallId: 'call-allowed',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'allowed/file.ts', content: 'allowed' }),
        });

        expect(denied.result.status).toBe('failed');
        expect(denied.result.error?.code).toBe('tool_failed');
        expect(denied.result.error?.message).toContain('child permission denied write');
        expect(allowed.result.status).toBe('completed');
        expect(executed.value).toBe(1);
    });

    it('evaluates scoped bash denies against extracted command path resources', async () => {
        const { runtime, contexts, executed } = buildPermissionRuntime();
        await runtime.runChildSession(makePermissionRequest([{ action: 'bash', resource: 'src/**', effect: 'deny' }]));
        const registry = contexts[0]?.childToolRegistry;
        const advertisement = registry?.advertise().find((tool) => tool.name === 'bash.run');
        expect(advertisement).toBeDefined();
        if (registry === undefined || advertisement === undefined) return;

        const denied = await registry.invoke({
            toolCallId: 'call-bash-denied',
            toolName: 'bash.run',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ commandLine: 'cat src/private.ts' }),
        });

        expect(denied.result.status).toBe('failed');
        expect(denied.result.error?.message).toContain('child permission denied bash');
        expect(executed.value).toBe(0);
    });

    it('normalizes workspace paths before applying scoped allow exceptions', async () => {
        const { runtime, contexts, executed } = buildPermissionRuntime();
        await runtime.runChildSession(
            makePermissionRequest([
                { action: 'write', resource: '**', effect: 'deny' },
                { action: 'write', resource: '.omo/plans/**', effect: 'allow' },
            ]),
        );
        const registry = contexts[0]?.childToolRegistry;
        const advertisement = registry?.advertise().find((tool) => tool.name === 'file.write');
        expect(advertisement).toBeDefined();
        if (registry === undefined || advertisement === undefined) return;

        const escaped = await registry.invoke({
            toolCallId: 'call-write-escape',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: '.omo/plans/../README.md', content: 'blocked' }),
        });
        const absoluteAllowed = await registry.invoke({
            toolCallId: 'call-write-absolute',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: '/tmp/workspace/.omo/plans/plan.md', content: 'allowed' }),
        });

        expect(escaped.result.status).toBe('failed');
        expect(absoluteAllowed.result.status).toBe('completed');
        expect(executed.value).toBe(1);
    });

    it('preserves retryable schema errors before scoped permission evaluation', async () => {
        const executed = { value: 0 };
        const registry = new ToolRegistry(
            createChildToolInvocationPolicy(
                [[{ action: 'write', resource: 'blocked/**', effect: 'deny' }]],
                '/tmp/workspace',
            ),
        );
        const advertisement = registry.register({
            name: 'file.write',
            description: 'Typed write test tool',
            capabilityClasses: ['file.write'],
            parametersJsonSchema: { type: 'object' },
            inputSchema: fileWriteInputSchema,
            outputSchema: toolOutputSchema,
            outputLimit: { maxModelOutputChars: 100 },
            execute: async () => {
                executed.value += 1;
                return { ok: true };
            },
        });

        const malformed = await registry.invoke({
            toolCallId: 'call-write-malformed',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'blocked/file.ts' }),
        });

        expect(malformed.result.status).toBe('failed');
        expect(malformed.result.error?.code).toBe('schema_invalid');
        expect(malformed.result.error?.retryable).toBe(true);
        expect(executed.value).toBe(0);
    });
});
