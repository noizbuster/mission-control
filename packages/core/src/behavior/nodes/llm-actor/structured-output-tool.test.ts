import { describe, expect, it } from 'vitest';
import { buildGenerateObjectInputSchema, GENERATE_OBJECT_TOOL_NAME } from './structured-output-tool';

describe('buildGenerateObjectInputSchema', () => {
    it('requires a boolean value for boolean shape', () => {
        const schema = buildGenerateObjectInputSchema({
            id: 'guard',
            kind: 'llm',
            config: { outputKey: 'guard.cleared', outputShape: 'boolean' },
        });
        expect(schema.safeParse({ value: true }).success).toBe(true);
        expect(schema.safeParse({ value: false }).success).toBe(true);
        expect(schema.safeParse({ value: 'true' }).success).toBe(false);
        expect(schema.safeParse({ value: 'Let me explore' }).success).toBe(false);
    });

    it('requires an enum value when outputEnum is declared', () => {
        const schema = buildGenerateObjectInputSchema({
            id: 'gate',
            kind: 'llm',
            config: {
                outputKey: 'intent.classification',
                outputEnum: ['trivial', 'explicit-implementation', 'ambiguous'],
            },
        });
        expect(schema.safeParse({ value: 'trivial' }).success).toBe(true);
        expect(schema.safeParse({ value: 'not-a-class' }).success).toBe(false);
    });

    it('requires an array value for array shape', () => {
        const schema = buildGenerateObjectInputSchema({
            id: 'todo-plan',
            kind: 'llm',
            config: { outputKey: 'plan.todos', outputShape: 'array' },
        });
        expect(schema.safeParse({ value: [{ description: 'a' }] }).success).toBe(true);
        expect(schema.safeParse({ value: 'not-array' }).success).toBe(false);
    });
});

describe('GENERATE_OBJECT_TOOL_NAME', () => {
    it('matches the OpenCode synthetic tool name', () => {
        expect(GENERATE_OBJECT_TOOL_NAME).toBe('generate_object');
    });
});
