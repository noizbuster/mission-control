import { describe, expect, it } from 'vitest';
import {
    buildGenerateObjectInputSchema,
    GENERATE_OBJECT_TOOL_NAME,
    resolveStructuredOutputFromTurn,
} from './structured-output-tool';

const AMBIGUITY_ENUM = ['clear', 'unclear', 'on-the-fence'] as const;

function ambiguityGateNode() {
    return {
        id: 'assess-ambiguity',
        kind: 'llm' as const,
        config: {
            outputKey: 'ambiguity.classification',
            outputEnum: [...AMBIGUITY_ENUM],
        },
    };
}

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

describe('resolveStructuredOutputFromTurn — capture admission (P3)', () => {
    it('rejects a generate_object capture blob when outputEnum is declared', () => {
        // Given: pure-gate capture of a non-enum object blob (defense-in-depth;
        // Zod may have been z.unknown() when outputEnum was missing historically)
        // When: resolveStructuredOutputFromTurn admits the capture
        // Then: ok:false — never raw ok:true
        const result = resolveStructuredOutputFromTurn({
            node: ambiguityGateNode(),
            pureStructuredGate: true,
            generateObjectCapture: {
                value: { reasoning: 'needs more research', nested: { label: 'unclear' } },
            },
            turnText: '',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('outputEnum');
        }
    });

    it('admits exact enum label "unclear" from generate_object capture', () => {
        // Given: capture value is exactly an allowed outputEnum label
        // When: resolveStructuredOutputFromTurn admits the capture
        // Then: ok:true with value "unclear"
        const result = resolveStructuredOutputFromTurn({
            node: ambiguityGateNode(),
            pureStructuredGate: true,
            generateObjectCapture: { value: 'unclear' },
            turnText: '',
        });
        expect(result).toEqual({ ok: true, value: 'unclear' });
    });

    it('rejects out-of-enum string capture', () => {
        const result = resolveStructuredOutputFromTurn({
            node: ambiguityGateNode(),
            pureStructuredGate: true,
            generateObjectCapture: { value: 'maybe-later' },
            turnText: '',
        });
        expect(result.ok).toBe(false);
    });

    it('rejects capture that fails outputShape even without outputEnum', () => {
        const result = resolveStructuredOutputFromTurn({
            node: {
                id: 'guard',
                kind: 'llm',
                config: { outputKey: 'guard.cleared', outputShape: 'boolean' },
            },
            pureStructuredGate: true,
            generateObjectCapture: { value: 'true' },
            turnText: '',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("expected shape 'boolean'");
        }
    });

    it('never returns raw ok:true for free-text outside outputEnum', () => {
        const result = resolveStructuredOutputFromTurn({
            node: ambiguityGateNode(),
            pureStructuredGate: false,
            generateObjectCapture: undefined,
            turnText: 'I think this is unclear after some thought.',
        });
        expect(result.ok).toBe(false);
    });
});

describe('GENERATE_OBJECT_TOOL_NAME', () => {
    it('matches the OpenCode synthetic tool name', () => {
        expect(GENERATE_OBJECT_TOOL_NAME).toBe('generate_object');
    });
});
