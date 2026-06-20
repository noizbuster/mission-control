import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';
import type { ToolRegistration } from './tool-registry-types.js';

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

    it('marks input schema_invalid settlements as model-retryable so the LLMActor graph keeps running', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register(echoTool());
        const argumentsJson = JSON.stringify({});

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_bad_input',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson,
        });

        // Then
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'schema_invalid', retryable: true },
        });
    });

    it('marks malformed-JSON settlements as model-retryable (same reason as input schema_invalid)', async () => {
        // Given
        const registry = new ToolRegistry();
        const advertised = registry.register(echoTool());

        // When
        const settlement = await registry.invoke({
            toolCallId: 'tool_call_bad_json',
            toolName: 'repo.echo',
            advertisedVersion: advertised.version,
            argumentsJson: '{not json',
        });

        // Then
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'schema_invalid', retryable: true },
        });
    });
});

describe('ToolRegistry — per-tool guideline', () => {
    // Fixed shape whose advertisedVersion was captured against the pre-guideline source. An
    // absent optional guideline is omitted from stableJson's Object.entries, so versionHashFor
    // stays byte-identical — persisted advertisedVersions keep validating after the field lands.
    const STABLE_ADVERTISED_VERSION = '70f32863c357324a1c88ecbe8fcead2576680447904ed0672de7be11e308b163';

    const stableTool: ToolRegistration<{ readonly text: string }, { readonly echoed: string }> = {
        name: 'baseline.echo',
        description: 'baseline echo probe',
        capabilityClasses: ['read'],
        parametersJsonSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
        },
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        outputLimit: { maxModelOutputChars: 32 },
        execute: (input) => ({ echoed: input.text }),
    };

    it('keeps a tool advertisedVersion byte-identical when no guideline is set (hash stability)', () => {
        const registry = new ToolRegistry();
        const advertised = registry.register(stableTool);

        expect(advertised.guideline).toBeUndefined();
        expect(advertised.version).toBe(STABLE_ADVERTISED_VERSION);
    });

    it('carries the guideline onto the advertisement when a tool sets one', () => {
        const registry = new ToolRegistry();
        const advertised = registry.register({ ...stableTool, guideline: 'prefer edit over write' });

        expect(advertised.guideline).toBe('prefer edit over write');
        expect(registry.advertise()[0]?.guideline).toBe('prefer edit over write');
    });

    it('participates in the advertisedVersion when present (two registries isolate the field)', () => {
        const withoutGuideline = new ToolRegistry().register(stableTool);
        const withGuideline = new ToolRegistry().register({ ...stableTool, guideline: 'prefer edit over write' });

        expect(withGuideline.version).not.toBe(withoutGuideline.version);
        expect(withGuideline.guideline).toBe('prefer edit over write');
        expect(withoutGuideline.guideline).toBeUndefined();
    });

    it('omits the guideline from the advertisement when set to an empty string', () => {
        const registry = new ToolRegistry();
        const advertised = registry.register({ ...stableTool, name: 'empty.guideline', guideline: '' });

        expect(advertised.guideline).toBe('');
    });
});

function echoTool(
    options: {
        readonly description?: string;
        readonly name?: string;
        readonly maxModelOutputChars?: number;
        readonly onExecute?: () => void;
    } = {},
) {
    return {
        name: options.name ?? 'repo.echo',
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
