import { describe, expect, it } from 'vitest';
import {
    type AskUserInput,
    type AskUserQuestionRequest,
    createAskUserToolRegistration,
} from './ask-user-tool.js';
import type { ToolExecutionContext } from './tool-registry-types.js';

function createContext(): ToolExecutionContext {
    return {
        toolCallId: 'call-test',
        toolName: 'ask_user',
        signal: new AbortController().signal,
    };
}

/**
 * Recording callback: pushes each received request onto `calls` and resolves
 * with the next scripted response. Keeps tests free of mock matchers so the
 * observed request shape is asserted with plain value equality.
 */
function createRecordingCallback(responses: readonly string[]): {
    readonly calls: AskUserQuestionRequest[];
    readonly fn: (request: AskUserQuestionRequest) => Promise<string>;
} {
    const calls: AskUserQuestionRequest[] = [];
    let next = 0;
    const fn = (request: AskUserQuestionRequest): Promise<string> => {
        calls.push(request);
        const response = responses[next] ?? '';
        next += 1;
        return Promise.resolve(response);
    };
    return { calls, fn };
}

describe('createAskUserToolRegistration', () => {
    describe('single-question mode (backward compat)', () => {
        it('calls the callback once with the question and string options, returns { answer }', async () => {
            const { calls, fn } = createRecordingCallback(['yes']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Deploy now?',
                options: ['yes', 'no'],
            };

            const output = await registration.execute(input, createContext());

            expect(output).toEqual({ answer: 'yes' });
            expect(calls).toEqual([{ question: 'Deploy now?', options: ['yes', 'no'] }]);
        });

        it('passes an empty options array to the callback when no options are supplied', async () => {
            const { calls, fn } = createRecordingCallback(['maybe']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Continue?',
                options: [],
            };

            const output = await registration.execute(input, createContext());

            expect(output).toEqual({ answer: 'maybe' });
            expect(calls[0]?.options).toEqual([]);
        });

        it('returns the raw answer string without labeling in single-question mode', async () => {
            const { fn } = createRecordingCallback(['yes']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Deploy now?',
                options: ['yes', 'no'],
            };

            const output = await registration.execute(input, createContext());

            // No "question: yes" prefix — the legacy shape passes the string through.
            expect(output.answer).toBe('yes');
        });
    });

    describe('multi-question mode', () => {
        it('calls the callback once per question in order and joins labeled answers with a newline', async () => {
            const { calls, fn } = createRecordingCallback(['Dark', 'English']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Setup wizard',
                options: [],
                questions: [
                    {
                        question: 'Pick a theme',
                        header: 'Theme',
                        options: [{ label: 'Dark' }, { label: 'Light' }],
                    },
                    {
                        question: 'Pick a language',
                        options: [{ label: 'English' }, { label: 'Korean' }],
                    },
                ],
            };

            const output = await registration.execute(input, createContext());

            // The header labels the first answer; the second falls back to its question text.
            expect(output).toEqual({ answer: 'Theme: Dark\nPick a language: English' });
            expect(calls).toEqual([
                {
                    question: 'Pick a theme',
                    options: [{ label: 'Dark' }, { label: 'Light' }],
                    header: 'Theme',
                },
                {
                    question: 'Pick a language',
                    options: [{ label: 'English' }, { label: 'Korean' }],
                },
            ]);
        });

        it('forwards the multiple flag to the callback when present on a question', async () => {
            const { calls, fn } = createRecordingCallback(['read, write']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Permissions',
                options: [],
                questions: [
                    {
                        question: 'Select all that apply',
                        multiple: true,
                        options: [{ label: 'read' }, { label: 'write' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]?.multiple).toBe(true);
        });

        it('omits the multiple key from the request when the question does not set it', async () => {
            const { calls, fn } = createRecordingCallback(['read']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick one',
                options: [],
                questions: [
                    {
                        question: 'Choose',
                        options: [{ label: 'read' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]).not.toHaveProperty('multiple');
        });

        it('omits the header key from the request when the question does not set it', async () => {
            const { calls, fn } = createRecordingCallback(['read']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick one',
                options: [],
                questions: [
                    {
                        question: 'Choose',
                        options: [{ label: 'read' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]).not.toHaveProperty('header');
        });

        it('passes an empty options array when a question omits options', async () => {
            const { calls, fn } = createRecordingCallback(['free text']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Summary',
                options: [],
                questions: [{ question: 'Describe the issue' }],
            };

            await registration.execute(input, createContext());

            expect(calls[0]?.options).toEqual([]);
        });

        it('takes precedence over the legacy options field on the same payload', async () => {
            const { calls, fn } = createRecordingCallback(['a']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Mixed',
                options: ['legacy-a', 'legacy-b'],
                questions: [{ question: 'New question', options: [{ label: 'new-a' }] }],
            };

            const output = await registration.execute(input, createContext());

            expect(calls).toHaveLength(1);
            expect(calls[0]?.question).toBe('New question');
            expect(calls[0]?.options).toEqual([{ label: 'new-a' }]);
            expect(output).toEqual({ answer: 'New question: a' });
        });

        it('returns an empty answer when the questions array is empty', async () => {
            const { calls, fn } = createRecordingCallback([]);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Summary',
                options: [],
                questions: [],
            };

            const output = await registration.execute(input, createContext());

            expect(output).toEqual({ answer: '' });
            expect(calls).toEqual([]);
        });

        it('invokes the callback strictly sequentially (no interleaving between questions)', async () => {
            const sequence: string[] = [];
            const fn = async (request: AskUserQuestionRequest): Promise<string> => {
                sequence.push(`start:${request.question}`);
                await Promise.resolve();
                sequence.push(`end:${request.question}`);
                return `ans:${request.question}`;
            };
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Sequential',
                options: [],
                questions: [{ question: 'first' }, { question: 'second' }, { question: 'third' }],
            };

            const output = await registration.execute(input, createContext());

            // Each start/end pair is contiguous; a parallel implementation would interleave.
            expect(sequence).toEqual([
                'start:first',
                'end:first',
                'start:second',
                'end:second',
                'start:third',
                'end:third',
            ]);
            expect(output.answer).toBe('first: ans:first\nsecond: ans:second\nthird: ans:third');
        });
    });

    describe('toModelOutput', () => {
        it('returns the answer string verbatim for a single-question response', () => {
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => Promise.resolve(''),
            });

            expect(registration.toModelOutput?.({ answer: 'yes' })).toBe('yes');
        });

        it('returns the formatted multi-question answer string verbatim', () => {
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => Promise.resolve(''),
            });

            expect(registration.toModelOutput?.({ answer: 'Theme: Dark\nLang: EN' })).toBe(
                'Theme: Dark\nLang: EN',
            );
        });
    });

    describe('registration metadata', () => {
        it('advertises the ask_user name and read capability class', () => {
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => Promise.resolve(''),
            });

            expect(registration.name).toBe('ask_user');
            expect(registration.capabilityClasses).toEqual(['read']);
        });
    });
});
