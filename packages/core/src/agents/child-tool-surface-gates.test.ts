import type { AgentDefinition, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerBashRunTool } from '../tools/bash-run';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { buildChildToolSurface } from './task-tool-runtime-authority';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inputSchema = z.record(z.string(), z.unknown());
const outputSchema = z.object({ ok: z.literal(true) }).strict();

describe('child tool surface structural gates', () => {
    it('drops job, team, and network while retaining bash approval behavior', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-child-surface-'));
        const permissionRequests: PermissionRequest[] = [];
        const executor = vi.fn(async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: 'ok',
            stderr: '',
            durationMs: 1,
        }));
        const parentToolRegistry = new ToolRegistry();
        parentToolRegistry.register(testRegistration('task', ['read']));
        parentToolRegistry.register(testRegistration('job', ['read']));
        parentToolRegistry.register(testRegistration('team_create', ['team']));
        parentToolRegistry.register(testRegistration('webfetch', ['network']));
        await registerBashRunTool(parentToolRegistry, {
            workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: (request) => {
                permissionRequests.push(request);
                return { requestId: request.id, status: 'allow' };
            },
            executor,
        });
        const childToolRegistry = buildChildToolSurface({
            parentToolRegistry,
            parentAgent: agent('parent'),
            child: agent('child', ['task', 'job', 'team_create', 'webfetch', 'bash.run']),
            childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
            categoryTools: undefined,
            workspaceRoot,
        });

        try {
            // When
            const names = childToolRegistry.advertise().map((tool) => tool.name);
            const bash = childToolRegistry.advertise().find((tool) => tool.name === 'bash.run');
            if (bash === undefined) throw new TypeError('bash.run was not retained');
            const settlement = await childToolRegistry.invoke({
                toolCallId: 'child-bash',
                toolName: bash.name,
                advertisedVersion: bash.version,
                argumentsJson: JSON.stringify({ commandLine: 'printf ok' }),
            });

            // Then
            expect(names).toEqual(['bash.run', 'yield']);
            expect(settlement.result.status).toBe('completed');
            expect(permissionRequests).toHaveLength(1);
            expect(permissionRequests[0]).toMatchObject({ action: 'bash.run', permission: { kind: 'bash' } });
            expect(executor).toHaveBeenCalledOnce();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function testRegistration(name: string, capabilityClasses: readonly string[]): ToolRegistration<unknown, unknown> {
    return {
        name,
        description: `Task 13 ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object' },
        inputSchema,
        outputSchema,
        outputLimit: { maxModelOutputChars: 100 },
        execute: async () => ({ ok: true }),
    };
}

function agent(name: string, tools?: string[]): AgentDefinition {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: `Act as ${name}.`,
        source: 'bundled',
        ...(tools !== undefined ? { tools } : {}),
    };
}
