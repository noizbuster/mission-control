import { describe, expect, it } from 'vitest';
import { taskToolInputSchema } from '../tools/task/task-tool.js';
import { adaptLegacyCategoryInput, adaptLegacySimpleInput } from './legacy-compat.js';

describe('legacy-compat', () => {
    describe('adaptLegacyCategoryInput', () => {
        it('maps a category-based task signature to the agent-based shape', () => {
            const result = adaptLegacyCategoryInput({ category: 'deep', prompt: 'X' });
            expect(result).toEqual({ agent: 'deep', assignment: 'X' });
        });

        it('maps a subagent_type-based task signature to the agent-based shape', () => {
            const result = adaptLegacyCategoryInput({ subagent_type: 'oracle', prompt: 'Z' });
            expect(result).toEqual({ agent: 'oracle', assignment: 'Z' });
        });

        it('prefers category over subagent_type when both are present', () => {
            const result = adaptLegacyCategoryInput({
                category: 'deep',
                subagent_type: 'oracle',
                prompt: 'X',
            });
            expect(result).toEqual({ agent: 'deep', assignment: 'X' });
        });

        it('defaults to the deep agent when neither category nor subagent_type is given', () => {
            const result = adaptLegacyCategoryInput({ prompt: 'X' });
            expect(result).toEqual({ agent: 'deep', assignment: 'X' });
        });
    });

    describe('adaptLegacySimpleInput', () => {
        it('maps a description+prompt task signature to the deep agent with a role', () => {
            const result = adaptLegacySimpleInput({ description: 'X', prompt: 'Y' });
            expect(result).toEqual({ agent: 'deep', assignment: 'Y', role: 'X' });
        });

        it('omits role when the description is empty', () => {
            const result = adaptLegacySimpleInput({ description: '', prompt: 'Y' });
            expect(result).toEqual({ agent: 'deep', assignment: 'Y' });
            expect(result).not.toHaveProperty('role');
        });

        it('omits role when the description is only whitespace', () => {
            const result = adaptLegacySimpleInput({ description: '   ', prompt: 'Y' });
            expect(result).toEqual({ agent: 'deep', assignment: 'Y' });
            expect(result).not.toHaveProperty('role');
        });

        it('trims surrounding whitespace from the role', () => {
            const result = adaptLegacySimpleInput({ description: '  X  ', prompt: 'Y' });
            expect(result).toEqual({ agent: 'deep', assignment: 'Y', role: 'X' });
        });
    });

    describe('schema XOR contract', () => {
        it('rejects input with both category and agent', () => {
            const result = taskToolInputSchema.safeParse({
                category: 'deep',
                agent: 'explore',
                prompt: 'X',
            });
            expect(result.success).toBe(false);
        });

        it('rejects input with both category and subagent_type', () => {
            const result = taskToolInputSchema.safeParse({
                category: 'deep',
                subagent_type: 'explore',
                prompt: 'X',
            });
            expect(result.success).toBe(false);
        });
    });
});
