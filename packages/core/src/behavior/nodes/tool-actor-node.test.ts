/**
 * Tests for the ToolActor node implementation.
 */

import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../tools/tool-registry.js';
import type { ToolRegistration } from '../../tools/tool-registry-types.js';
import type { AbgNodeRunContext } from '../node-registry.js';
import { runToolActorNode } from './tool-actor-node.js';

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

function eventTypes(signals: readonly AbgSignal[]): string[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .map((signal) => signal.event.type);
}

const echoRegistration: ToolRegistration<{ text: string }, { text: string }> = {
    name: 'echo',
    description: 'Echo a string back to the model.',
    capabilityClasses: ['read'],
    parametersJsonSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
    },
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    outputLimit: { maxModelOutputChars: 2000 },
    execute: async (input) => ({ text: input.text }),
    toModelOutput: (output) => output.text,
};

describe('tool-actor-node', () => {
    const baseContext: AbgNodeRunContext = {
        graphId: 'g1',
        now: () => '2026-06-16T00:00:00.000Z',
    };

    it('emits tool.started and tool.completed on successful tool invocation', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const node: AbgNodeSpec = {
            id: 'call-echo',
            kind: 'tool',
            config: {
                tool: 'echo',
                arguments: { text: 'hello world' },
            },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'emit', 'success']);
        expect(eventTypes(signals)).toEqual(['tool.started', 'tool.completed']);

        const successSignal = signals.find((s) => s.type === 'success');
        if (successSignal?.type !== 'success') {
            throw new Error('Expected success signal');
        }
        expect(successSignal.result).toEqual({
            toolName: 'echo',
            output: 'hello world',
        });
    });

    it('emits failure when ToolRegistry is unavailable', async () => {
        const node: AbgNodeSpec = {
            id: 'no-registry',
            kind: 'tool',
            config: { tool: 'echo' },
        };

        const signals = await collectSignals(runToolActorNode(node, baseContext));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
        expect(eventTypes(signals)).toEqual(['tool.failed']);

        const failureSignal = signals.find((s) => s.type === 'failure');
        if (failureSignal?.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        expect(failureSignal.error).toEqual({
            code: 'tool_registry_unavailable',
            message: 'ToolRegistry not available in context',
        });
    });

    it('emits failure when tool name is missing or invalid', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const testCases = [
            { config: {}, expectedCode: 'tool_name_required' },
            { config: { tool: '' }, expectedCode: 'tool_name_required' },
            { config: { tool: 123 }, expectedCode: 'tool_name_required' },
        ];

        for (const testCase of testCases) {
            const node: AbgNodeSpec = {
                id: 'bad-tool-name',
                kind: 'tool',
                config: testCase.config,
            };

            const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
            expect(eventTypes(signals)).toEqual(['tool.failed']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe(testCase.expectedCode);
        }
    });

    it('emits failure when tool is unknown', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const node: AbgNodeSpec = {
            id: 'unknown-tool',
            kind: 'tool',
            config: { tool: 'does_not_exist' },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
        expect(eventTypes(signals)).toEqual(['tool.failed']);

        const failureSignal = signals.find((s) => s.type === 'failure');
        if (failureSignal?.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        expect(failureSignal.error).toEqual({
            code: 'tool_unknown',
            toolName: 'does_not_exist',
            message: 'Unknown tool: does_not_exist',
        });
    });

    it('emits failure with schema_invalid code when arguments fail schema validation', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const node: AbgNodeSpec = {
            id: 'bad-args',
            kind: 'tool',
            config: { tool: 'echo', arguments: { wrong: 'field' } },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'emit', 'failure']);
        expect(eventTypes(signals)).toContain('tool.started');
        expect(eventTypes(signals)).toContain('tool.failed');

        const failureSignal = signals.find((s) => s.type === 'failure');
        if (failureSignal?.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        expect((failureSignal.error as { code: string }).code).toBe('schema_invalid');
    });

    it('uses node.id as toolCallId when not provided in config', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const node: AbgNodeSpec = {
            id: 'my-tool-call',
            kind: 'tool',
            config: { tool: 'echo', arguments: { text: 'test' } },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        const startedEvent = signals.find((s) => s.type === 'emit');
        if (startedEvent?.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(startedEvent.event.payload).toEqual({
            toolName: 'echo',
            toolCallId: 'my-tool-call',
        });
    });

    it('uses provided toolCallId from config when available', async () => {
        const registry = new ToolRegistry();
        registry.register(echoRegistration);

        const node: AbgNodeSpec = {
            id: 'node-id',
            kind: 'tool',
            config: {
                tool: 'echo',
                toolCallId: 'custom-call-id',
                arguments: { text: 'test' },
            },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        const startedEvent = signals.find((s) => s.type === 'emit');
        if (startedEvent?.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(startedEvent.event.payload).toEqual({
            toolName: 'echo',
            toolCallId: 'custom-call-id',
        });
    });

    it('uses modelOutput.content as fallback when result.output is undefined', async () => {
        const registry = new ToolRegistry();
        const customRegistration: ToolRegistration<{ value: number }, { result: string }> = {
            name: 'no-raw-output',
            description: 'A tool that only returns structured output',
            capabilityClasses: ['read'],
            parametersJsonSchema: {
                type: 'object',
                properties: { value: { type: 'number' } },
                required: ['value'],
                additionalProperties: false,
            },
            inputSchema: z.object({ value: z.number() }),
            outputSchema: z.object({ result: z.string() }),
            outputLimit: { maxModelOutputChars: 2000 },
            execute: async (input) => ({ result: `value-${input.value}` }),
            toModelOutput: (output) => output.result,
        };
        registry.register(customRegistration);

        const node: AbgNodeSpec = {
            id: 'no-raw',
            kind: 'tool',
            config: { tool: 'no-raw-output', arguments: { value: 42 } },
        };

        const signals = await collectSignals(runToolActorNode(node, { ...baseContext, toolRegistry: registry }));

        const successSignal = signals.find((s) => s.type === 'success');
        if (successSignal?.type !== 'success') {
            throw new Error('Expected success signal');
        }
        expect(successSignal.result).toEqual({
            toolName: 'no-raw-output',
            output: 'value-42',
        });
    });
});
