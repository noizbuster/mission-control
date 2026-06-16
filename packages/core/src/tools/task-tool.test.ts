import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { spawnChildCodingAgent } from '../behavior/subagents/spawn-child.js';
import { createChildToolRegistry, createTaskToolRegistration, TASK_TOOL_NAME } from './task-tool.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolRegistration } from './tool-registry-types.js';

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
const bashRegistration: ToolRegistration<{ cmd: string }, { out: string }> = {
    name: 'shell',
    description: 'Run a shell command.',
    capabilityClasses: ['bash.run'],
    parametersJsonSchema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
    },
    inputSchema: z.object({ cmd: z.string() }),
    outputSchema: z.object({ out: z.string() }),
    outputLimit: { maxModelOutputChars: 1000 },
    execute: async () => ({ out: 'ok' }),
};

function buildParentRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(readRegistration);
    registry.register(bashRegistration);
    registry.register(
        createTaskToolRegistration({ spawn: async () => ({ description: 'd', status: 'completed', summary: 's' }) }),
    );
    return registry;
}

describe('createChildToolRegistry (recursion guard)', () => {
    it('keeps read-safe tools and drops the task tool + destructive tools', () => {
        const child = createChildToolRegistry(buildParentRegistry());
        const names = child.advertise().map((a) => a.name);
        expect(names).toContain('lookup');
        expect(names).not.toContain('shell');
        expect(names).not.toContain(TASK_TOOL_NAME);
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
            parentToolRegistry: buildParentRegistry(),
            now: () => NOW,
            sessionId: 'session_child_spawn',
        });
        expect(output.status).toBe('completed');
        expect(output.summary).toBe('The answer is 42.');
    });

    it('the child tool surface excludes task + destructive tools (recursion + safety guard)', async () => {
        const model = new MockLanguageModelV3({
            provider: MODEL.providerID,
            modelId: MODEL.modelID,
            doStream: async () => ({ stream: convertArrayToReadableStream(textChunks('done')) }),
        });
        // The child built from a parent that includes task + shell advertises ONLY lookup.
        const childRegistry = createChildToolRegistry(buildParentRegistry());
        expect(childRegistry.advertise().map((a) => a.name)).toEqual(['lookup']);

        // And the child run still completes.
        const output = await spawnChildCodingAgent({
            description: 'noop',
            prompt: 'finish',
            resolveSdkModel: () => model,
            model: MODEL,
            parentToolRegistry: buildParentRegistry(),
            now: () => NOW,
            sessionId: 'session_child_guard',
        });
        expect(output.status).toBe('completed');
    });
});
