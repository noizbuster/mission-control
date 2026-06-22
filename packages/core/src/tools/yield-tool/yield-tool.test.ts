import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ToolExecutionContext, ToolExecutionError } from '../tool-registry-types.js';
import {
    type CreateYieldToolOptions,
    createYieldToolRegistration,
    YIELD_TOOL_NAME,
    yieldInputSchema,
} from './yield-tool.js';

// --- Fixtures ---------------------------------------------------------------

function buildTool(options?: Partial<CreateYieldToolOptions>): ReturnType<typeof createYieldToolRegistration> {
    return createYieldToolRegistration({
        ...(options?.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
    });
}

const CTX: ToolExecutionContext = {
    toolCallId: 'tc_test',
    toolName: YIELD_TOOL_NAME,
    signal: new AbortController().signal,
};

// --- Tests ------------------------------------------------------------------

describe('yield tool — registration metadata', () => {
    it('uses the canonical tool name', () => {
        const tool = buildTool();
        expect(tool.name).toBe(YIELD_TOOL_NAME);
        expect(YIELD_TOOL_NAME).toBe('yield');
    });

    it('declares the yield capability class', () => {
        const tool = buildTool();
        expect(tool.capabilityClasses).toEqual(['yield']);
    });

    it('requires result in the advertised JSON schema', () => {
        const tool = buildTool();
        const schema = tool.parametersJsonSchema as { readonly required: readonly string[] };
        expect(schema.required).toEqual(['result']);
    });

    it('provides a guideline referencing the output schema contract', () => {
        const tool = buildTool();
        expect(tool.guideline).toContain('yield');
        expect(tool.guideline).toContain('output schema');
    });
});

describe('yield tool — input schema validation', () => {
    it('parses a result with no findings', () => {
        const parsed = yieldInputSchema.parse({ result: { answer: 42 } });
        expect(parsed.result).toEqual({ answer: 42 });
        expect(parsed.findings).toBeUndefined();
    });

    it('parses a result with a findings array', () => {
        const parsed = yieldInputSchema.parse({ result: 'done', findings: [{ note: 'x' }] });
        expect(parsed.result).toBe('done');
        expect(parsed.findings).toEqual([{ note: 'x' }]);
    });

    it('rejects extra fields (strict mode)', () => {
        const result = yieldInputSchema.safeParse({ result: 'done', extra: true });
        expect(result.success).toBe(false);
    });

    it('rejects a non-array findings value', () => {
        const result = yieldInputSchema.safeParse({ result: 'done', findings: 'not-array' });
        expect(result.success).toBe(false);
    });
});

describe('yield tool — execute with no output schema (accepts any result)', () => {
    it('accepts a result and returns the submitted status', async () => {
        const tool = buildTool();
        const result = await tool.execute(yieldInputSchema.parse({ result: { anything: true } }), CTX);
        expect(result.status).toBe('submitted');
    });

    it('returns the canonical stop-now message', async () => {
        const tool = buildTool();
        const result = await tool.execute(yieldInputSchema.parse({ result: 'done' }), CTX);
        expect(result.message).toBe('Result submitted. You can stop now.');
    });

    it('accepts a findings array in the input', async () => {
        const tool = buildTool();
        const input = yieldInputSchema.parse({ result: 'done', findings: [{ k: 'v' }, { k: 'w' }] });
        const result = await tool.execute(input, CTX);
        expect(result.status).toBe('submitted');
    });
});

describe('yield tool — execute with an output schema', () => {
    const schema = z.object({ answer: z.number() }).strict();

    it('accepts a result matching the output schema', async () => {
        const tool = buildTool({ outputSchema: schema });
        const result = await tool.execute(yieldInputSchema.parse({ result: { answer: 42 } }), CTX);
        expect(result.status).toBe('submitted');
    });

    it('throws ToolExecutionError (schema_invalid, retryable) on a schema violation', async () => {
        const tool = buildTool({ outputSchema: schema });
        const input = yieldInputSchema.parse({ result: { answer: 'not a number' } });
        const caught = await Promise.resolve(tool.execute(input, CTX)).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(ToolExecutionError);
        const tx = caught as ToolExecutionError;
        expect(tx.error.code).toBe('schema_invalid');
        expect(tx.error.retryable).toBe(true);
        expect(tx.error.message).toContain('output schema');
    });

    it('rejects a result missing required schema fields', async () => {
        const tool = buildTool({ outputSchema: schema });
        const input = yieldInputSchema.parse({ result: { wrong: 1 } });
        const caught = await Promise.resolve(tool.execute(input, CTX)).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(ToolExecutionError);
    });
});

describe('yield tool — toModelOutput', () => {
    it('returns the canonical stop-now message', () => {
        const tool = buildTool();
        const output = { status: 'submitted' as const, message: 'Result submitted. You can stop now.' };
        expect(tool.toModelOutput?.(output)).toBe('Result submitted. You can stop now.');
    });
});
