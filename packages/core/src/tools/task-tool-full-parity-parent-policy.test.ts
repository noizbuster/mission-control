import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentDefinition, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFullParityTaskToolRegistrationForCli } from './task-tool-full-parity-factory.js';
import { ToolRegistry } from './tool-registry.js';

const allowAll = (request: PermissionRequest): PermissionDecision => ({
    requestId: request.id,
    status: 'allow',
});

describe('full-parity task parent policy authority', () => {
    it('inherits denies from the canonical parent AgentDefinition under permissive approval', async () => {
        const capturedToolNames: string[][] = [];
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'parent-policy-capture',
            doStream: async (options) => {
                capturedToolNames.push((options.tools ?? []).map((tool) => tool.name));
                return { stream: convertArrayToReadableStream(yieldChunks()) };
            },
        });
        const parentToolRegistry = new ToolRegistry();
        for (const [name, capability] of [
            ['file.write', 'file.write'],
            ['bash.run', 'bash.run'],
        ] as const) {
            parentToolRegistry.register({
                name,
                description: `${name} policy probe`,
                capabilityClasses: [capability],
                parametersJsonSchema: { type: 'object' },
                inputSchema: z.object({}).strict(),
                outputSchema: z.object({ ok: z.literal(true) }).strict(),
                outputLimit: { maxModelOutputChars: 100 },
                execute: async () => ({ ok: true as const }),
            });
        }
        const parentAgent: AgentDefinition = {
            name: 'coding-agent',
            description: 'Policy-constrained parent',
            systemPrompt: '',
            source: 'bundled',
            spawns: '*',
            pathPolicies: [
                { action: 'write', resource: '**', effect: 'deny' },
                { action: 'bash', resource: '**', effect: 'deny' },
            ],
        };
        const registration = await createFullParityTaskToolRegistrationForCli({
            workspaceRoot: '/tmp/workspace',
            requestPermission: allowAll,
            resolveSdkModel: () => model,
            model: { providerID: 'local', modelID: 'local-echo' },
            parentToolRegistry,
            parentAgent,
        });

        const result = await registration.execute(
            { agent: 'deep', assignment: 'attempt mutations', load_skills: [] },
            { toolCallId: 'parent-policy-task', toolName: 'task', signal: new AbortController().signal },
        );

        expect(result.status).toBe('completed');
        expect(capturedToolNames[0]).not.toContain('file.write');
        expect(capturedToolNames[0]).not.toContain('bash.run');
    });
});

function yieldChunks(): LanguageModelV3StreamPart[] {
    const input = JSON.stringify({ result: 'parent policy applied' });
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'yield-call', toolName: 'yield' },
        { type: 'tool-input-delta', id: 'yield-call', delta: input },
        { type: 'tool-input-end', id: 'yield-call' },
        { type: 'tool-call', toolCallId: 'yield-call', toolName: 'yield', input },
        {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
        },
    ];
}
