import { describe, expect, it } from 'vitest';
import {
    createDebugToolRegistration,
    DEBUG_TOOL_NAME,
    type DebugInput,
    type DebugOutput,
    registerDebugTool,
} from './debug-tool';
import { ToolRegistry } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';

const EXEC_CONTEXT: ToolExecutionContext = {
    toolCallId: 'call_test',
    toolName: DEBUG_TOOL_NAME,
    signal: new AbortController().signal,
};

describe('registerDebugTool (config gating)', () => {
    it('advertises the debug tool when enabled', () => {
        const registry = new ToolRegistry();
        registerDebugTool(registry, { enabled: true });

        const advertised = registry.advertise().find((tool) => tool.name === DEBUG_TOOL_NAME);
        expect(advertised).toBeDefined();
        expect(advertised?.capabilityClasses).toEqual(['exec']);
    });

    it('does NOT advertise the debug tool when disabled (default-off config gate)', () => {
        const registry = new ToolRegistry();
        const advertisement = registerDebugTool(registry, { enabled: false });

        expect(advertisement).toBeUndefined();
        expect(registry.advertise().some((tool) => tool.name === DEBUG_TOOL_NAME)).toBe(false);
    });

    it('leaves the registry empty when never registered', () => {
        const registry = new ToolRegistry();
        expect(registry.advertise()).toEqual([]);
    });
});

describe('debug execute (scaffold seam)', () => {
    it('returns status not_yet_implemented for a known adapter (not a thrown crash)', async () => {
        const registration = createDebugToolRegistration();
        const output = await registration.execute({ adapter: 'lldb-dap', command: 'noop' }, EXEC_CONTEXT);
        const parsed: DebugOutput = registration.outputSchema.parse(output);
        expect(parsed.status).toBe('not_yet_implemented');
        expect(parsed.adapter).toBe('lldb-dap');
        expect(parsed.command).toBe('noop');
        expect(parsed.message).toContain('not yet implemented');
    });

    it('returns not_yet_implemented for an unknown adapter (clear signal, not a crash)', async () => {
        const registration = createDebugToolRegistration();
        const output = await registration.execute({ adapter: 'totally-fake-adapter', command: 'launch' }, EXEC_CONTEXT);
        expect(output.status).toBe('not_yet_implemented');
        expect(output.adapter).toBe('totally-fake-adapter');
    });

    it('settles as a completed (not failed) tool result through the registry invoke path', async () => {
        const registry = new ToolRegistry();
        const advertisement = registerDebugTool(registry, { enabled: true });
        if (advertisement === undefined) throw new Error('advertisement must be defined when enabled');

        const input: DebugInput = { adapter: 'debugpy', command: 'continue' };
        const settlement = await registry.invoke({
            toolCallId: 'call_invoke',
            toolName: DEBUG_TOOL_NAME,
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({ status: 'not_yet_implemented' });
    });

    it('exposes a human-readable model output', () => {
        const registration = createDebugToolRegistration();
        const modelOutput = registration.toModelOutput?.({
            status: 'not_yet_implemented',
            adapter: 'dlv',
            command: 'step_over',
            message: 'deferred',
        });
        expect(modelOutput).toContain('not_yet_implemented');
    });
});
