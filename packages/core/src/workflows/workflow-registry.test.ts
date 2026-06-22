import type { Category, Mode, WorkflowSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { WorkflowRegistry } from './workflow-registry.js';

function workflowSpec(name: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: `graph-${name}`,
            entryNodeId: 'start',
            nodes: [{ id: 'start', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function category(id: string): Category {
    return {
        id,
        permissions: ['read'],
    };
}

function mode(id: string): Mode {
    return {
        id,
        policies: [],
    };
}

describe('WorkflowRegistry — workflows', () => {
    it('registers discovered workflows from constructor', () => {
        const registry = new WorkflowRegistry([workflowSpec('alpha'), workflowSpec('beta')]);
        expect(registry.names()).toEqual(['alpha', 'beta']);
        expect(registry.list().length).toBe(2);
    });

    it('lookup resolves by name and returns undefined for missing', () => {
        const registry = new WorkflowRegistry([workflowSpec('alpha')]);
        expect(registry.lookup('alpha')?.name).toBe('alpha');
        expect(registry.lookup('missing')).toBeUndefined();
    });

    it('registerWorkflow adds a new workflow programmatically', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerWorkflow(workflowSpec('manual'));
        expect(registry.lookup('manual')?.name).toBe('manual');
        expect(registry.names()).toEqual(['manual']);
    });

    it('register alias delegates to registerWorkflow', () => {
        const registry = new WorkflowRegistry([]);
        registry.register(workflowSpec('aliased'));
        expect(registry.lookup('aliased')?.name).toBe('aliased');
        expect(registry.names()).toEqual(['aliased']);
    });

    it('programmatic registration overrides discovered on name collision', () => {
        const discovered = workflowSpec('alpha');
        const registry = new WorkflowRegistry([discovered]);
        const programmatic = workflowSpec('alpha');
        registry.registerWorkflow(programmatic);
        expect(registry.lookup('alpha')).toBe(programmatic);
        expect(registry.lookup('alpha')).not.toBe(discovered);
    });

    it('collision preserves insertion order (first position wins)', () => {
        const registry = new WorkflowRegistry([workflowSpec('alpha'), workflowSpec('beta')]);
        registry.registerWorkflow(workflowSpec('alpha'));
        expect(registry.names()).toEqual(['alpha', 'beta']);
        expect(registry.list().length).toBe(2);
    });

    it('list returns a defensive copy', () => {
        const registry = new WorkflowRegistry([workflowSpec('alpha')]);
        const first = registry.list();
        const second = registry.list();
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });
});

describe('WorkflowRegistry — categories', () => {
    it('registerCategory adds a category', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerCategory(category('quick'));
        expect(registry.lookupCategory('quick')?.id).toBe('quick');
    });

    it('lookupCategory returns undefined for missing id', () => {
        const registry = new WorkflowRegistry([]);
        expect(registry.lookupCategory('missing')).toBeUndefined();
    });

    it('listCategories returns all registered categories in insertion order', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerCategory(category('quick'));
        registry.registerCategory(category('deep'));
        registry.registerCategory(category('oracle'));
        expect(registry.listCategories().map((c) => c.id)).toEqual(['quick', 'deep', 'oracle']);
    });

    it('listCategories is empty by default', () => {
        const registry = new WorkflowRegistry([]);
        expect(registry.listCategories()).toEqual([]);
    });

    it('re-registering a category id overwrites the value but keeps order', () => {
        const registry = new WorkflowRegistry([]);
        const original = category('quick');
        const replacement: Category = { id: 'quick', permissions: ['read', 'edit'] };
        registry.registerCategory(original);
        registry.registerCategory(replacement);
        expect(registry.lookupCategory('quick')).toBe(replacement);
        expect(registry.listCategories().length).toBe(1);
        expect(registry.listCategories().map((c) => c.id)).toEqual(['quick']);
    });

    it('listCategories returns a defensive copy', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerCategory(category('quick'));
        const first = registry.listCategories();
        const second = registry.listCategories();
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });
});

describe('WorkflowRegistry — modes', () => {
    it('registerMode adds a mode', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerMode(mode('autopilot'));
        expect(registry.lookupMode('autopilot')?.id).toBe('autopilot');
    });

    it('lookupMode returns undefined for missing id', () => {
        const registry = new WorkflowRegistry([]);
        expect(registry.lookupMode('missing')).toBeUndefined();
    });

    it('listModes returns all registered modes in insertion order', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerMode(mode('autopilot'));
        registry.registerMode(mode('review'));
        expect(registry.listModes().map((m) => m.id)).toEqual(['autopilot', 'review']);
    });

    it('listModes is empty by default', () => {
        const registry = new WorkflowRegistry([]);
        expect(registry.listModes()).toEqual([]);
    });

    it('re-registering a mode id overwrites the value but keeps order', () => {
        const registry = new WorkflowRegistry([]);
        const original = mode('autopilot');
        const replacement: Mode = {
            id: 'autopilot',
            systemPromptOverlay: 'be certain',
            policies: [],
        };
        registry.registerMode(original);
        registry.registerMode(replacement);
        expect(registry.lookupMode('autopilot')).toBe(replacement);
        expect(registry.listModes().length).toBe(1);
        expect(registry.listModes().map((m) => m.id)).toEqual(['autopilot']);
    });

    it('listModes returns a defensive copy', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerMode(mode('autopilot'));
        const first = registry.listModes();
        const second = registry.listModes();
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });
});

describe('WorkflowRegistry — cross-collection independence', () => {
    it('workflows, categories, and modes do not interfere', () => {
        const registry = new WorkflowRegistry([workflowSpec('planner')]);
        registry.registerCategory(category('deep'));
        registry.registerMode(mode('autopilot'));

        expect(registry.names()).toEqual(['planner']);
        expect(registry.listCategories().map((c) => c.id)).toEqual(['deep']);
        expect(registry.listModes().map((m) => m.id)).toEqual(['autopilot']);
    });

    it('same string key in different collections does not collide', () => {
        const registry = new WorkflowRegistry([]);
        registry.registerWorkflow(workflowSpec('shared'));
        registry.registerCategory(category('shared'));
        registry.registerMode(mode('shared'));

        expect(registry.lookup('shared')?.name).toBe('shared');
        expect(registry.lookupCategory('shared')?.id).toBe('shared');
        expect(registry.lookupMode('shared')?.id).toBe('shared');
    });
});
