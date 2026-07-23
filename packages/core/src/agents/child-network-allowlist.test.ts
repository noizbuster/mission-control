import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getCategory } from '../tools/task/category-catalog';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import {
    CHILD_HARD_DROPPED_CAPABILITY_KINDS,
    CHILD_NETWORK_ALLOWED_CATEGORIES,
    hasHardDroppedCapability,
    isChildNetworkCategoryAllowed,
} from './child-graph-spawn';
import { isCategoryToolAllowed } from './child-tool-permissions';
import { buildChildToolSurface } from './task-tool-runtime-authority';

const inputSchema = z.record(z.string(), z.unknown());
const outputSchema = z.object({ ok: z.literal(true) }).strict();

const ON_CATEGORIES = ['architect', 'librarian', 'deep', 'reasoner', 'oracle', 'designer', 'planner'] as const;
const OFF_CATEGORIES = ['explore', 'reviewer', 'quick'] as const;
const NETWORK_TOOL_NAMES = ['webfetch', 'web_search', 'mcp__docs__lookup'] as const;

describe('CHILD_NETWORK_ALLOWED_CATEGORIES (todo 1b)', () => {
    it('keeps network in the global hard-drop set', () => {
        expect(CHILD_HARD_DROPPED_CAPABILITY_KINDS.has('network')).toBe(true);
        expect(CHILD_HARD_DROPPED_CAPABILITY_KINDS.has('workflow')).toBe(true);
        expect(CHILD_HARD_DROPPED_CAPABILITY_KINDS.has('team')).toBe(true);
        expect(CHILD_HARD_DROPPED_CAPABILITY_KINDS.has('subagent')).toBe(true);
    });

    it('allowlists only the seven ON categories and agents', () => {
        expect([...CHILD_NETWORK_ALLOWED_CATEGORIES].sort()).toEqual([...ON_CATEGORIES].sort());
        for (const off of OFF_CATEGORIES) {
            expect(isChildNetworkCategoryAllowed(off)).toBe(false);
        }
        for (const on of ON_CATEGORIES) {
            expect(isChildNetworkCategoryAllowed(on)).toBe(true);
        }
    });

    it('treats network and subagent hard-drop exceptions as separate filters', () => {
        expect(hasHardDroppedCapability(['network'])).toBe(true);
        expect(hasHardDroppedCapability(['network'], { allowNetworkCapability: true })).toBe(false);
        expect(hasHardDroppedCapability(['network'], { allowSubagentNesting: true })).toBe(true);
        expect(hasHardDroppedCapability(['subagent'], { allowNetworkCapability: true })).toBe(true);
        expect(hasHardDroppedCapability(['subagent'], { allowSubagentNesting: true })).toBe(false);
        expect(
            hasHardDroppedCapability(['workflow', 'team'], {
                allowNetworkCapability: true,
                allowSubagentNesting: true,
            }),
        ).toBe(true);
    });

    it('admits webfetch, web_search, and mcp__* from explicit category tool entries', () => {
        const tools = ['read', 'webfetch', 'web_search', 'mcp__*'] as const;
        expect(isCategoryToolAllowed('webfetch', tools)).toBe(true);
        expect(isCategoryToolAllowed('web_search', tools)).toBe(true);
        expect(isCategoryToolAllowed('mcp__docs__lookup', tools)).toBe(true);
        expect(isCategoryToolAllowed('mcp__docs__lookup', ['read', 'webfetch', 'web_search'])).toBe(false);
        expect(isCategoryToolAllowed('webfetch', ['read', 'ls'])).toBe(false);
        expect(isCategoryToolAllowed('mcp__docs__lookup', ['read', 'ls'])).toBe(false);
        expect(isCategoryToolAllowed('webfetch', undefined)).toBe(true);
    });

    it('catalog ON categories with explicit tools list webfetch and web_search; OFF do not', () => {
        for (const id of ON_CATEGORIES) {
            const category = getCategory(id);
            expect(category).toBeDefined();
            if (category?.tools === undefined) {
                // deep/reasoner: ALLOW_ALL (no tools list) — network admitted via hard-drop exception
                expect(['deep', 'reasoner']).toContain(id);
                continue;
            }
            expect(category.tools).toContain('webfetch');
            expect(category.tools).toContain('web_search');
            expect(category.tools).toContain('mcp__*');
        }
        for (const id of OFF_CATEGORIES) {
            const category = getCategory(id);
            expect(category?.tools ?? []).not.toContain('webfetch');
            expect(category?.tools ?? []).not.toContain('web_search');
            expect(category?.tools ?? []).not.toContain('mcp__*');
        }
    });

    it('buildChildToolSurface retains network for every ON category id when parent advertises them', () => {
        const parent = parentWithNetworkTools();
        for (const id of ON_CATEGORIES) {
            const category = getCategory(id);
            const surface = buildChildToolSurface({
                parentToolRegistry: parent,
                parentAgent: agent('parent'),
                child: agent(id, category?.tools !== undefined ? [...category.tools] : undefined),
                childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
                categoryTools: category?.tools,
                categoryId: id,
                workspaceRoot: '/tmp/ws',
            });
            const names = surface.advertise().map((tool) => tool.name);
            for (const networkTool of NETWORK_TOOL_NAMES) {
                expect(names, `${id} should retain ${networkTool}`).toContain(networkTool);
            }
            expect(names).toContain('read');
            expect(names).toContain('yield');
            expect(names).not.toContain('workflow');
            expect(names).not.toContain('team_create');
        }
    });

    it('buildChildToolSurface drops network for every OFF category even if tools list names them', () => {
        const parent = parentWithNetworkTools();
        for (const id of OFF_CATEGORIES) {
            const surface = buildChildToolSurface({
                parentToolRegistry: parent,
                parentAgent: agent('parent'),
                child: agent(id, ['read', 'webfetch', 'web_search', 'mcp__docs__lookup']),
                childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
                categoryTools: ['read', 'webfetch', 'web_search', 'mcp__docs__lookup'],
                categoryId: id,
                workspaceRoot: '/tmp/ws',
            });
            const names = surface.advertise().map((tool) => tool.name);
            expect(names).toContain('read');
            for (const networkTool of NETWORK_TOOL_NAMES) {
                expect(names, `${id} must not retain ${networkTool}`).not.toContain(networkTool);
            }
        }
    });

    it('ON category keeps network while depth-gated nesting still controls task independently', () => {
        const parent = parentWithNetworkTools();
        parent.register(reg('task', ['subagent']));
        parent.register(reg('job', ['subagent']));
        const librarianTools = ['read', 'webfetch', 'web_search', 'mcp__*', 'task', 'job'] as const;

        const nestedOn = buildChildToolSurface({
            parentToolRegistry: parent,
            parentAgent: agent('parent'),
            child: agent('librarian', [...librarianTools]),
            childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
            categoryTools: [...librarianTools],
            categoryId: 'librarian',
            workspaceRoot: '/tmp/ws',
            allowTaskNesting: true,
        });
        const nestedNames = nestedOn.advertise().map((tool) => tool.name);
        expect(nestedNames).toContain('webfetch');
        expect(nestedNames).toContain('web_search');
        expect(nestedNames).toContain('mcp__docs__lookup');
        expect(nestedNames).toContain('task');
        expect(nestedNames).not.toContain('workflow');

        const leafOn = buildChildToolSurface({
            parentToolRegistry: parent,
            parentAgent: agent('parent'),
            child: agent('librarian', [...librarianTools]),
            childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
            categoryTools: [...librarianTools],
            categoryId: 'librarian',
            workspaceRoot: '/tmp/ws',
            allowTaskNesting: false,
        });
        const leafNames = leafOn.advertise().map((tool) => tool.name);
        expect(leafNames).toContain('webfetch');
        expect(leafNames).toContain('web_search');
        expect(leafNames).not.toContain('task');
        expect(leafNames).not.toContain('job');

        const nestedOff = buildChildToolSurface({
            parentToolRegistry: parent,
            parentAgent: agent('parent'),
            child: agent('explore', ['read', 'webfetch', 'task']),
            childPermissions: [{ action: '*', resource: '**', effect: 'allow' }],
            categoryTools: ['read', 'webfetch', 'task'],
            categoryId: 'explore',
            workspaceRoot: '/tmp/ws',
            allowTaskNesting: true,
        });
        const offNames = nestedOff.advertise().map((tool) => tool.name);
        expect(offNames).toContain('task');
        expect(offNames).not.toContain('webfetch');
        expect(offNames).not.toContain('web_search');
    });
});

function parentWithNetworkTools(): ToolRegistry {
    const parent = new ToolRegistry();
    parent.register(reg('webfetch', ['network']));
    parent.register(reg('web_search', ['network']));
    parent.register(reg('mcp__docs__lookup', ['network']));
    parent.register(reg('workflow', ['workflow']));
    parent.register(reg('team_create', ['team']));
    parent.register(reg('read', ['read']));
    return parent;
}

function reg(name: string, capabilityClasses: readonly string[]): ToolRegistration<unknown, unknown> {
    return {
        name,
        description: name,
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
