import { createChildToolRegistry, TASK_TOOL_NAME, ToolRegistry } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { createChildToolRegistry as createChildToolRegistryFromBarrel } from './tools/public-orchestration-exports.js';

describe('simple task child registry public exports', () => {
    it('exports the compatibility helper and task name from the package root', () => {
        expect(typeof createChildToolRegistry).toBe('function');
        expect(createChildToolRegistryFromBarrel).toBe(createChildToolRegistry);
        expect(TASK_TOOL_NAME).toBe('task');
    });

    it('accepts the public ToolRegistry type at the compatibility boundary', () => {
        const registry = new ToolRegistry();
        expect(createChildToolRegistry(registry)).toBeInstanceOf(ToolRegistry);
    });
});
