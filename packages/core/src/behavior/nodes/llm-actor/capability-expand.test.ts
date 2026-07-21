import { describe, expect, it } from 'vitest';
import { expandCapabilityLabels } from './capability-expand';
import { filterByCapabilities } from './llm-actor-node-helpers';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types';

function ad(name: string, capabilityClasses: readonly string[]): ToolAdvertisement {
    return {
        name,
        description: `${name} tool`,
        capabilityClasses,
        version: 'test',
        outputLimit: { maxModelOutputChars: 8_000 },
        providerTool: {
            name,
            description: `${name} tool`,
            parametersJsonSchema: { type: 'object', properties: {} },
        },
    };
}

const registry: readonly ToolAdvertisement[] = [
    ad('glob', ['read']),
    ad('ast_grep', ['read']),
    ad('skill', ['read']),
    ad('repo.read', ['repo.read']),
    ad('read', ['repo.read']),
    ad('ls', ['repo.read']),
    ad('file.edit', ['file.edit']),
    ad('file.write', ['file.write']),
    ad('file.patch', ['file.patch']),
    ad('hashline_edit', ['file.edit']),
    ad('bash.run', ['bash.run']),
    ad('command.run', ['command.run']),
    ad('task', ['subagent']),
    ad('workflow', ['workflow']),
    ad('webfetch', ['network']),
    ad('learn', ['write']),
];

describe('expandCapabilityLabels', () => {
    it('Given coarse read When expanded Then includes repo.read and bare read', () => {
        const set = expandCapabilityLabels(['read']);
        expect(set.has('read')).toBe(true);
        expect(set.has('repo.read')).toBe(true);
        expect(set.has('file.edit')).toBe(false);
    });

    it('Given coarse write When expanded Then includes edit-class file tools', () => {
        const set = expandCapabilityLabels(['write']);
        expect(set.has('write')).toBe(true);
        expect(set.has('edit')).toBe(true);
        expect(set.has('file.edit')).toBe(true);
        expect(set.has('file.write')).toBe(true);
        expect(set.has('file.patch')).toBe(true);
        expect(set.has('bash.run')).toBe(false);
    });

    it('Given unknown label When expanded Then keeps the label as-is', () => {
        const set = expandCapabilityLabels(['custom.plugin']);
        expect(set.has('custom.plugin')).toBe(true);
        expect(set.size).toBe(1);
    });

    it("Given ['read','subagent'] When expanded Then intersects task tool class so task is advertisable", () => {
        const set = expandCapabilityLabels(['read', 'subagent']);
        expect(set.has('read')).toBe(true);
        expect(set.has('repo.read')).toBe(true);
        expect(set.has('subagent')).toBe(true);
        const names = filterByCapabilities(registry, ['read', 'subagent']).map((tool) => tool.name);
        expect(names).toContain('task');
        expect(names).toEqual(expect.arrayContaining(['glob', 'repo.read', 'read', 'task']));
        expect(names).not.toContain('file.edit');
        expect(names).not.toContain('bash.run');
        expect(names).not.toContain('webfetch');
    });
});

describe('filterByCapabilities (OpenCode-style expand)', () => {
    it('Given undefined capabilities When filtering Then returns the full registry', () => {
        expect(filterByCapabilities(registry, undefined)).toEqual(registry);
    });

    it('Given empty capabilities When filtering Then returns no tools', () => {
        expect(filterByCapabilities(registry, [])).toEqual([]);
    });

    it('Given read-only node When filtering Then includes repo.read tools not only bare read', () => {
        const names = filterByCapabilities(registry, ['read']).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(['glob', 'ast_grep', 'skill', 'repo.read', 'read', 'ls']));
        expect(names).not.toContain('learn');
        expect(names).not.toContain('file.edit');
        expect(names).not.toContain('bash.run');
        expect(names).not.toContain('task');
    });

    it('Given write node When filtering Then advertises file.edit/file.write/file.patch', () => {
        const names = filterByCapabilities(registry, ['write']).map((tool) => tool.name);
        expect(names).toEqual(
            expect.arrayContaining(['file.edit', 'file.write', 'file.patch', 'hashline_edit', 'learn']),
        );
        expect(names).not.toContain('repo.read');
        expect(names).not.toContain('bash.run');
    });

    it('Given read+write node When filtering Then advertises both read and edit tools', () => {
        const names = filterByCapabilities(registry, ['read', 'write']).map((tool) => tool.name);
        expect(names).toEqual(
            expect.arrayContaining(['repo.read', 'file.edit', 'file.write', 'glob', 'hashline_edit']),
        );
        expect(names).not.toContain('bash.run');
        expect(names).not.toContain('task');
    });

    it('Given bash node When filtering Then advertises bash.run and command.run', () => {
        const names = filterByCapabilities(registry, ['bash']).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(['bash.run', 'command.run']));
        expect(names).not.toContain('file.edit');
    });

    it('Given fine-grained file.edit capability When filtering Then still matches', () => {
        const names = filterByCapabilities(registry, ['file.edit']).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(['file.edit', 'hashline_edit']));
    });

    it('Given subagent-only node When filtering Then only task-class tools remain', () => {
        const names = filterByCapabilities(registry, ['subagent']).map((tool) => tool.name);
        expect(names).toEqual(['task']);
    });

    it('Given stale filesystem.write label When filtering Then maps to file mutation tools', () => {
        const names = filterByCapabilities(registry, ['filesystem.write']).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(['file.edit', 'file.write', 'file.patch']));
    });
});
