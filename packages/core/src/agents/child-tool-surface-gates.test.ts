import type { AgentDefinition, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerBashRunTool } from '../tools/bash-run';
import { getCategory } from '../tools/task/category-catalog';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import {
    CHILD_HARD_DROPPED_CAPABILITY_KINDS,
    CHILD_NETWORK_ALLOWED_CATEGORIES,
} from './child-graph-spawn';
import { buildChildToolSurface } from './task-tool-runtime-authority';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inputSchema = z.record(z.string(), z.unknown());
const outputSchema = z.object({ ok: z.literal(true) }).strict();
const NETWORK_ALLOWED_CATEGORY_IDS = ['librarian', 'deep', 'reasoner', 'oracle', 'designer', 'planner'] as const;
const NETWORK_BLOCKED_CATEGORY_IDS = ['explore', 'reviewer', 'quick'] as const;
const NETWORK_TOOL_NAMES = ['webfetch', 'web_search', 'mcp__fixture__echo'] as const;

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

    it('keeps network in the default hard-drop set while exporting the child network allowlist', () => {
        // Given
        const exportedAllowlist = [...CHILD_NETWORK_ALLOWED_CATEGORIES];

        // When
        const defaultDropsNetwork = CHILD_HARD_DROPPED_CAPABILITY_KINDS.has('network');

        // Then
        expect(defaultDropsNetwork).toBe(true);
        expect(exportedAllowlist.sort()).toEqual([...NETWORK_ALLOWED_CATEGORY_IDS].sort());
    });

    it.each(NETWORK_BLOCKED_CATEGORY_IDS)('blocks network tools for %s children even when nesting is allowed', (id) => {
        // Given
        const names = namesForCategory(id, true);

        // Then
        for (const toolName of NETWORK_TOOL_NAMES) {
            expect(names).not.toContain(toolName);
        }
        expect(names).not.toContain('workflow');
        expect(names).not.toContain('team_create');
    });

    it.each(NETWORK_ALLOWED_CATEGORY_IDS)('allows network tools for %s children without lifting workflow/team', (id) => {
        // Given
        const names = namesForCategory(id, true);

        // Then
        for (const toolName of NETWORK_TOOL_NAMES) {
            expect(names).toContain(toolName);
        }
        expect(names).not.toContain('workflow');
        expect(names).not.toContain('team_create');
    });

    it('keeps network allowance independent from blocked subagent nesting', () => {
        // Given
        const names = namesForCategory('librarian', false);

        // Then
        for (const toolName of NETWORK_TOOL_NAMES) {
            expect(names).toContain(toolName);
        }
        expect(names).not.toContain('task');
        expect(names).not.toContain('job');
    });

    it("category:'explore' at depth-block has no write/bash/network/task tools", () => {
        // Given / When
        const names = namesForCategory('explore', false, {
            extraParentTools: WRITE_AND_BASH_TOOLS,
            extraChildTools: ['task', 'job', ...WRITE_AND_BASH_TOOLS.map((tool) => tool.name)],
        });

        // Then
        expect(names).toContain('read');
        expect(names).toContain('yield');
        expect(names).not.toContain('task');
        expect(names).not.toContain('job');
        for (const toolName of [...NETWORK_TOOL_NAMES, ...WRITE_AND_BASH_TOOL_NAMES]) {
            expect(names, `explore depth-block must drop ${toolName}`).not.toContain(toolName);
        }
    });

    it("category:'explore' at depth-allow may have task but still no network/write/bash", () => {
        // Given / When
        const names = namesForCategory('explore', true, {
            extraParentTools: WRITE_AND_BASH_TOOLS,
            extraChildTools: ['task', 'job', ...WRITE_AND_BASH_TOOLS.map((tool) => tool.name)],
        });

        // Then
        expect(names).toContain('task');
        expect(names).toContain('read');
        expect(names).toContain('yield');
        for (const toolName of [...NETWORK_TOOL_NAMES, ...WRITE_AND_BASH_TOOL_NAMES]) {
            expect(names, `explore depth-allow must drop ${toolName}`).not.toContain(toolName);
        }
    });

    it("category:'librarian' at depth-allow keeps network tools and task", () => {
        // Given / When
        const names = namesForCategory('librarian', true, {
            extraChildTools: ['task', 'job'],
        });

        // Then
        expect(names).toContain('task');
        for (const toolName of NETWORK_TOOL_NAMES) {
            expect(names).toContain(toolName);
        }
        expect(names).not.toContain('workflow');
        expect(names).not.toContain('team_create');
    });
});

const WRITE_AND_BASH_TOOLS = [
    { name: 'file.edit', classes: ['file.edit'] },
    { name: 'file.write', classes: ['file.write'] },
    { name: 'bash.run', classes: ['bash.run'] },
] as const;
const WRITE_AND_BASH_TOOL_NAMES = WRITE_AND_BASH_TOOLS.map((tool) => tool.name);

function namesForCategory(
    categoryId: string,
    allowTaskNesting: boolean,
    options?: {
        readonly extraParentTools?: readonly { readonly name: string; readonly classes: readonly string[] }[];
        readonly extraChildTools?: readonly string[];
    },
): readonly string[] {
    const category = getCategory(categoryId);
    if (category === undefined) throw new TypeError(`missing category ${categoryId}`);
    const parentToolRegistry = new ToolRegistry();
    parentToolRegistry.register(testRegistration('read', ['read']));
    parentToolRegistry.register(testRegistration('task', ['subagent']));
    parentToolRegistry.register(testRegistration('job', ['subagent']));
    parentToolRegistry.register(testRegistration('workflow', ['workflow']));
    parentToolRegistry.register(testRegistration('team_create', ['team']));
    parentToolRegistry.register(testRegistration('webfetch', ['network']));
    parentToolRegistry.register(testRegistration('web_search', ['network']));
    parentToolRegistry.register(testRegistration('mcp__fixture__echo', ['network']));
    for (const tool of options?.extraParentTools ?? []) {
        parentToolRegistry.register(testRegistration(tool.name, tool.classes));
    }

    const extraChildTools = options?.extraChildTools ?? [];
    const childTools =
        category.tools === undefined && extraChildTools.length === 0
            ? undefined
            : [...(category.tools ?? []), ...extraChildTools];
    const categoryTools =
        category.tools === undefined && extraChildTools.length === 0
            ? undefined
            : [...new Set([...(category.tools ?? []), ...extraChildTools])];

    return buildChildToolSurface({
        parentToolRegistry,
        parentAgent: agent('parent'),
        child: agent(category.id, childTools),
        childPermissions: category.permissions,
        categoryTools,
        categoryId: category.id,
        workspaceRoot: '/tmp/workspace',
        allowTaskNesting,
    })
        .advertise()
        .map((tool) => tool.name);
}

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

function agent(name: string, tools?: readonly string[]): AgentDefinition {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: `Act as ${name}.`,
        source: 'bundled',
        ...(tools !== undefined ? { tools: [...tools] } : {}),
    };
}
