import { describe, expect, it } from 'vitest';
import { createEvalToolBridge } from './eval-tool-bridge';

describe('eval tool bridge', () => {
    it('allows read-only tools and blocks eval/task/mcp__', () => {
        const bridge = createEvalToolBridge({ invokeTool: async () => 'ok' });
        expect(bridge.isToolAllowed('read')).toBe(true);
        expect(bridge.isToolAllowed('ls')).toBe(true);
        expect(bridge.isToolAllowed('grep')).toBe(true);
        expect(bridge.isToolAllowed('find')).toBe(true);
        expect(bridge.isToolAllowed('glob')).toBe(true);
        expect(bridge.isToolAllowed('repo.read')).toBe(true);
        expect(bridge.isToolAllowed('repo.list')).toBe(true);
        expect(bridge.isToolAllowed('repo.search')).toBe(true);
        expect(bridge.isToolAllowed('eval')).toBe(false);
        expect(bridge.isToolAllowed('task')).toBe(false);
        expect(bridge.isToolAllowed('mcp__foo__bar')).toBe(false);
        expect(bridge.isToolAllowed('bash.run')).toBe(false);
        expect(bridge.isToolAllowed('file.write')).toBe(false);
        expect(bridge.isToolAllowed('webfetch')).toBe(false);
    });

    it('routes allowed tool calls through invokeTool with the original args', async () => {
        const seen: Array<{ readonly name: string; readonly args: unknown }> = [];
        const bridge = createEvalToolBridge({
            invokeTool: async (name, args) => {
                seen.push({ name, args });
                return `invoked:${name}`;
            },
        });
        const result = await bridge.handleToolCall('read', { path: '/tmp' });
        expect(result).toBe('invoked:read');
        expect(seen).toEqual([{ name: 'read', args: { path: '/tmp' } }]);
    });

    it('throws when a blocked tool is requested and does not call invokeTool', async () => {
        let called = false;
        const bridge = createEvalToolBridge({
            invokeTool: async () => {
                called = true;
                return 'should not reach';
            },
        });
        await expect(bridge.handleToolCall('eval', {})).rejects.toThrow(/eval re-entry blocked/);
        await expect(bridge.handleToolCall('task', {})).rejects.toThrow(/eval re-entry blocked/);
        await expect(bridge.handleToolCall('mcp__foo__bar', {})).rejects.toThrow(/eval re-entry blocked/);
        expect(called).toBe(false);
    });
});
