import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';

describe('ToolRegistry', () => {
    it('advertises schema-validated tools with stable version hashes', () => {
        // Given
        const registry = new ToolRegistry();

        // When
        const advertisement = registry.register(echoTool());

        // Then
        expect(advertisement).toMatchObject({
            name: 'repo.echo',
            description: 'Echo text for registry tests',
            capabilityClasses: ['repo.read'],
            outputLimit: {
                maxModelOutputChars: 32,
            },
        });
        expect(advertisement.version).toMatch(/^[a-f0-9]{64}$/);
        expect(advertisement.providerTool).toEqual({
            name: 'repo.echo',
            description: 'Echo text for registry tests',
            parametersJsonSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                },
                required: ['text'],
            },
        });
    });

    it('rejects stale advertised versions before invoking the tool', async () => {
        // Given
        const registry = new ToolRegistry();
        let calls = 0;
        const advertised = registry.register(echoTool({ onExecute: () => (calls += 1) }));
        registry.register(echoTool({ description: 'Echo text after replacement', onExecute: () => (calls += 1) }));

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_stale',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ text: 'hello' }),
        });

        // Then
        expect(calls).toBe(0);
        expect(settlement.result).toMatchObject({
            toolCallId: 'tool_call_stale',
            status: 'failed',
            error: {
                code: 'tool_failed',
            },
        });
        expect(settlement.events).toContainEqual(
            expect.objectContaining({
                type: 'tool.failed',
                taskId: 'tool_call_stale',
                toolResult: settlement.result,
            }),
        );
    });

    it('bounds model-facing output and marks truncation without mutating structured output', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register(echoTool());

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_large',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ text: 'abcdefghijklmnopqrstuvwxyz0123456789' }),
        });

        // Then
        expect(settlement.result).toMatchObject({
            toolCallId: 'tool_call_large',
            status: 'completed',
        });
        expect(settlement.structuredOutput).toEqual({ echoed: 'abcdefghijklmnopqrstuvwxyz0123456789' });
        expect(settlement.modelOutput).toEqual({
            content: 'abcdefghijklmnopqrstuvwxyz012...',
            truncated: true,
            originalLength: 36,
            limit: 32,
        });
        expect(settlement.result.output).toBe('abcdefghijklmnopqrstuvwxyz012...');
        expect(settlement.result.output?.length).toBeLessThanOrEqual(32);
    });

    it('keeps the truncation marker inside the advertised output limit', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register(echoTool({ maxModelOutputChars: 8 }));

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_tiny_limit',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ text: 'abcdefghijkl' }),
        });

        // Then
        expect(settlement.modelOutput).toEqual({
            content: 'abcde...',
            truncated: true,
            originalLength: 12,
            limit: 8,
        });
        expect(settlement.result.output).toBe('abcde...');
        expect(settlement.result.output?.length).toBeLessThanOrEqual(8);
    });

    it('correlates successful tool result events with tool call ids', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register(echoTool());

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_success',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ text: 'hello' }),
        });

        // Then
        expect(settlement.events).toContainEqual(
            expect.objectContaining({
                type: 'tool.completed',
                taskId: 'tool_call_success',
                message: 'tool completed: repo.echo',
                toolResult: settlement.result,
            }),
        );
        expect(settlement.result.toolCallId).toBe('tool_call_success');
    });

    it('executes with parsed input after Zod transforms', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register({
            name: 'repo.count',
            description: 'Count transformed input',
            capabilityClasses: ['repo.read'],
            parametersJsonSchema: {
                type: 'object',
                properties: {
                    count: { type: 'string' },
                },
                required: ['count'],
            },
            inputSchema: z.object({
                count: z.string().transform((value) => Number.parseInt(value, 10)),
            }),
            outputSchema: z.object({
                doubled: z.number(),
            }),
            outputLimit: {
                maxModelOutputChars: 32,
            },
            execute(input: { readonly count: number }) {
                return { doubled: input.count * 2 };
            },
        });

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_transform',
            toolName: 'repo.count',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ count: '21' }),
        });

        // Then
        expect(settlement.result).toMatchObject({
            toolCallId: 'tool_call_transform',
            status: 'completed',
            output: '{"doubled":42}',
        });
    });
});

function echoTool(
    options: {
        readonly description?: string;
        readonly maxModelOutputChars?: number;
        readonly onExecute?: () => void;
    } = {},
) {
    return {
        name: 'repo.echo',
        description: options.description ?? 'Echo text for registry tests',
        capabilityClasses: ['repo.read'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
            },
            required: ['text'],
        },
        inputSchema: z.object({
            text: z.string(),
        }),
        outputSchema: z.object({
            echoed: z.string(),
        }),
        outputLimit: {
            maxModelOutputChars: options.maxModelOutputChars ?? 32,
        },
        execute(input: { readonly text: string }) {
            options.onExecute?.();
            return { echoed: input.text };
        },
        toModelOutput(output: { readonly echoed: string }) {
            return output.echoed;
        },
    };
}
