import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child';
import { createChildToolRegistry, createTaskToolRegistration, TASK_TOOL_NAME } from './task-tool';
import { ToolRegistry } from './tool-registry';
import type { ToolRegistration } from './tool-registry-types';

const NOW = '2026-06-16T00:00:00.000Z';
const MODEL = { providerID: 'anthropic', modelID: 'claude-fable-5' } as const;

function usage() {
    return {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
}
function textChunks(text: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage() },
    ];
}

const readRegistration: ToolRegistration<{ q: string }, { a: string }> = {
    name: 'lookup',
    description: 'Read-only lookup.',
    capabilityClasses: ['read'],
    parametersJsonSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
    },
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.object({ a: z.string() }),
    outputLimit: { maxModelOutputChars: 1000 },
    execute: async () => ({ a: 'found' }),
};

function capabilityRegistration(
    name: string,
    capabilityClasses: readonly string[],
): ToolRegistration<{ readonly q: string }, { readonly a: string }> {
    return {
        name,
        description: `${name} tool`,
        capabilityClasses,
        parametersJsonSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
            additionalProperties: false,
        },
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ a: z.string() }),
        outputLimit: { maxModelOutputChars: 1000 },
        execute: async () => ({ a: 'ok' }),
    };
}

function buildChildRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(readRegistration);
    return registry;
}

describe('createChildToolRegistry (compatibility safety filter)', () => {
    it('keeps read tools and drops task, destructive, network, MCP, workflow, and team tools', () => {
        const parent = new ToolRegistry();
        parent.register(readRegistration);
        for (const [name, capabilities] of [
            ['file.edit', ['edit']],
            ['file.write', ['write']],
            ['file.patch', ['patch']],
            ['bash.run', ['bash']],
            ['webfetch', ['network']],
            ['mcp__server__lookup', ['network']],
            ['mcp', ['network']],
            ['task', ['subagent']],
            ['workflow', ['workflow']],
            ['team', ['team']],
        ] as const) {
            parent.register(capabilityRegistration(name, capabilities));
        }

        const child = createChildToolRegistry(parent);

        expect(child.advertise().map((advertisement) => advertisement.name)).toEqual(['lookup']);
        expect(child.advertise().some((advertisement) => advertisement.name === TASK_TOOL_NAME)).toBe(false);
    });
});

describe('createTaskToolRegistration (spawn contract)', () => {
    it('forwards the delegation to the spawn function and returns its output', async () => {
        let received: { description: string; prompt: string } | undefined;
        const tool = createTaskToolRegistration({
            spawn: async (input) => {
                received = input;
                return { description: input.description, status: 'completed', summary: 'child answered' };
            },
        });
        const result = await tool.execute(
            { description: 'find x', prompt: 'where is x?' },
            { toolCallId: 'c1', toolName: 'task', signal: new AbortController().signal },
        );
        expect(received).toEqual({ description: 'find x', prompt: 'where is x?' });
        expect(result).toEqual({ description: 'find x', status: 'completed', summary: 'child answered' });
    });

    it('wraps a throwing spawn in a ToolExecutionError', async () => {
        const tool = createTaskToolRegistration({
            spawn: async () => {
                throw new Error('boom');
            },
        });
        await expect(
            tool.execute(
                { description: 'd', prompt: 'p' },
                { toolCallId: 'c1', toolName: 'task', signal: new AbortController().signal },
            ),
        ).rejects.toThrow(/task "d" failed: boom/);
    });
});

describe('spawnChildCodingAgent (end-to-end child run)', () => {
    it('runs the child graph and returns the final assistant text as the summary', async () => {
        const model = new MockLanguageModelV3({
            provider: MODEL.providerID,
            modelId: MODEL.modelID,
            doStream: async () => ({ stream: convertArrayToReadableStream(textChunks('The answer is 42.')) }),
        });
        const output = await spawnChildCodingAgent({
            description: 'answer',
            prompt: 'What is the answer?',
            resolveSdkModel: () => model,
            model: MODEL,
            childToolRegistry: buildChildRegistry(),
            now: () => NOW,
            sessionId: 'session_child_spawn',
        });
        expect(output.status).toBe('completed');
        expect(output.summary).toBe('The answer is 42.');
    });
});
