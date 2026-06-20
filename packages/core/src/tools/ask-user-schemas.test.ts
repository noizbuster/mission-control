import { describe, expect, it } from 'vitest';
import {
    type AskUserOption,
    type AskUserQuestion,
    askUserInputSchema,
    askUserOptionSchema,
    askUserOutputSchema,
    askUserParametersJsonSchema,
    askUserQuestionSchema,
} from './ask-user-schemas.js';

describe('ask_user schemas', () => {
    describe('askUserInputSchema — single-question (legacy) mode', () => {
        it('validates a legacy { question, options } payload', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Deploy now?',
                options: ['yes', 'no'],
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.question).toBe('Deploy now?');
                expect(parsed.data.options).toEqual(['yes', 'no']);
            }
        });

        it('defaults options to an empty array when omitted (backward compat)', () => {
            const parsed = askUserInputSchema.safeParse({ question: 'Continue?' });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.options).toEqual([]);
            }
        });

        it('validates an empty options array', () => {
            const parsed = askUserInputSchema.safeParse({ question: 'Continue?', options: [] });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.options).toEqual([]);
            }
        });

        it('rejects an empty question', () => {
            const parsed = askUserInputSchema.safeParse({ question: '', options: ['a'] });

            expect(parsed.success).toBe(false);
        });

        it('rejects a question longer than 4000 characters', () => {
            const parsed = askUserInputSchema.safeParse({ question: 'x'.repeat(4_001) });

            expect(parsed.success).toBe(false);
        });

        it('rejects more than 50 legacy options', () => {
            const options: string[] = [];
            for (let index = 0; index < 51; index += 1) {
                options.push(`opt-${index}`);
            }

            const parsed = askUserInputSchema.safeParse({ question: 'q', options });

            expect(parsed.success).toBe(false);
        });

        it('accepts exactly 50 legacy options (boundary)', () => {
            const options: string[] = [];
            for (let index = 0; index < 50; index += 1) {
                options.push(`opt-${index}`);
            }

            const parsed = askUserInputSchema.safeParse({ question: 'q', options });

            expect(parsed.success).toBe(true);
        });

        it('rejects empty-string options', () => {
            const parsed = askUserInputSchema.safeParse({ question: 'q', options: [''] });

            expect(parsed.success).toBe(false);
        });

        it('rejects options whose label exceeds 500 characters', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'q',
                options: ['x'.repeat(501)],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects unknown top-level keys (strict)', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'q',
                unexpectedField: true,
            });

            expect(parsed.success).toBe(false);
        });
    });

    describe('askUserInputSchema — multi-question mode', () => {
        it('validates a multi-question payload with labeled options and descriptions', () => {
            const input = {
                question: 'Setup wizard',
                questions: [
                    {
                        question: 'Pick a theme',
                        header: 'Theme',
                        options: [
                            { label: 'Dark', description: 'Low-light friendly' },
                            { label: 'Light', description: 'Daytime friendly' },
                        ],
                    },
                    {
                        question: 'Pick a language',
                        options: [{ label: 'English' }, { label: 'Korean' }],
                    },
                ],
            };

            const parsed = askUserInputSchema.safeParse(input);

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.questions).toHaveLength(2);
                const first = parsed.data.questions?.[0];
                expect(first?.header).toBe('Theme');
                expect(first?.options).toHaveLength(2);
            }
        });

        it('validates a question with multiple: true', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Permissions',
                questions: [
                    {
                        question: 'Select all that apply',
                        multiple: true,
                        options: [{ label: 'read' }, { label: 'write' }],
                    },
                ],
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.questions?.[0]?.multiple).toBe(true);
            }
        });

        it('validates a question with no options (free-text)', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Summary',
                questions: [{ question: 'Describe the issue' }],
            });

            expect(parsed.success).toBe(true);
        });

        it('accepts a mix of legacy options and new questions on the same payload', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Mixed mode',
                options: ['legacy-a', 'legacy-b'],
                questions: [{ question: 'New question', options: [{ label: 'new-a' }] }],
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.options).toEqual(['legacy-a', 'legacy-b']);
                expect(parsed.data.questions).toHaveLength(1);
            }
        });

        it('rejects a sub-question longer than 4000 characters', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Summary',
                questions: [{ question: 'x'.repeat(4_001) }],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects an option label longer than 500 characters', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'Summary',
                questions: [
                    {
                        question: 'Pick',
                        options: [{ label: 'x'.repeat(501) }],
                    },
                ],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects more than 50 questions', () => {
            const questions: AskUserQuestion[] = [];
            for (let index = 0; index < 51; index += 1) {
                questions.push({ question: `q-${index}` });
            }

            const parsed = askUserInputSchema.safeParse({ question: 'summary', questions });

            expect(parsed.success).toBe(false);
        });

        it('rejects more than 50 options on a single question', () => {
            const options: AskUserOption[] = [];
            for (let index = 0; index < 51; index += 1) {
                options.push({ label: `opt-${index}` });
            }

            const parsed = askUserInputSchema.safeParse({
                question: 'summary',
                questions: [{ question: 'q', options }],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects unknown keys inside a question (strict)', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'summary',
                questions: [{ question: 'q', unexpected: true }],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects unknown keys inside an option (strict)', () => {
            const parsed = askUserInputSchema.safeParse({
                question: 'summary',
                questions: [
                    {
                        question: 'q',
                        options: [{ label: 'a', unexpected: true }],
                    },
                ],
            });

            expect(parsed.success).toBe(false);
        });
    });

    describe('askUserQuestionSchema', () => {
        it('validates a minimal question with only the required text', () => {
            const parsed = askUserQuestionSchema.safeParse({ question: 'Why?' });

            expect(parsed.success).toBe(true);
        });

        it('rejects an empty label on an option', () => {
            const parsed = askUserQuestionSchema.safeParse({
                question: 'Why?',
                options: [{ label: '' }],
            });

            expect(parsed.success).toBe(false);
        });

        it('rejects a header longer than 500 characters', () => {
            const parsed = askUserQuestionSchema.safeParse({
                question: 'Why?',
                header: 'x'.repeat(501),
            });

            expect(parsed.success).toBe(false);
        });
    });

    describe('askUserOptionSchema', () => {
        it('validates a labeled option without a description', () => {
            const parsed = askUserOptionSchema.safeParse({ label: 'Confirm' });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.label).toBe('Confirm');
                expect(parsed.data.description).toBeUndefined();
            }
        });

        it('validates a labeled option with a description', () => {
            const parsed = askUserOptionSchema.safeParse({
                label: 'Confirm',
                description: 'Proceed with the action',
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.description).toBe('Proceed with the action');
            }
        });

        it('rejects a description longer than 4000 characters', () => {
            const parsed = askUserOptionSchema.safeParse({
                label: 'Confirm',
                description: 'x'.repeat(4_001),
            });

            expect(parsed.success).toBe(false);
        });
    });

    describe('askUserOutputSchema', () => {
        it('validates an answer payload', () => {
            const parsed = askUserOutputSchema.safeParse({ answer: 'yes' });

            expect(parsed.success).toBe(true);
        });

        it('rejects a payload missing the answer', () => {
            const parsed = askUserOutputSchema.safeParse({});

            expect(parsed.success).toBe(false);
        });
    });

    describe('askUserParametersJsonSchema', () => {
        type OptionSchemaView = {
            readonly type: string;
            readonly items?: {
                readonly oneOf?: readonly { readonly type: string }[];
            };
        };
        type QuestionOptionView = {
            readonly items: {
                readonly properties: {
                    readonly label: unknown;
                    readonly description: unknown;
                };
            };
        };
        type QuestionSchemaView = {
            readonly type: string;
            readonly items: {
                readonly properties: {
                    readonly question: unknown;
                    readonly header: unknown;
                    readonly options: QuestionOptionView;
                    readonly multiple: unknown;
                };
                readonly required: readonly string[];
            };
        };
        type JsonSchemaView = {
            readonly type: string;
            readonly properties: {
                readonly options: OptionSchemaView;
                readonly questions: QuestionSchemaView;
            };
            readonly required: readonly string[];
            readonly additionalProperties: boolean;
        };

        function schemaView(): JsonSchemaView {
            return askUserParametersJsonSchema() as JsonSchemaView;
        }

        it('declares question as the only required property', () => {
            const schema = schemaView();

            expect(schema.type).toBe('object');
            expect(schema.required).toEqual(['question']);
            expect(schema.additionalProperties).toBe(false);
        });

        it('exposes legacy options as an array accepting strings and labeled option objects', () => {
            const options = schemaView().properties.options;

            expect(options.type).toBe('array');
            expect(options.items?.oneOf?.[0]?.type).toBe('string');
            expect(options.items?.oneOf?.[1]?.type).toBe('object');
        });

        it('exposes questions as an array with labeled options and multiple flag', () => {
            const questions = schemaView().properties.questions;

            expect(questions.type).toBe('array');
            expect(questions.items.required).toEqual(['question']);
            expect(questions.items.properties.multiple).toBeDefined();
            expect(questions.items.properties.options.items.properties.label).toBeDefined();
            expect(questions.items.properties.options.items.properties.description).toBeDefined();
        });
    });
});
