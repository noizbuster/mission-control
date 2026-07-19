import { describe, expect, it } from 'vitest';
import { askUserInputSchema, askUserQuestionSchema } from './ask-user-schemas';
import {
    ASK_USER_BLOCKED_ANSWER,
    type AskUserInput,
    type AskUserQuestionRequest,
    createAskUserToolRegistration,
} from './ask-user-tool';
import type { ToolExecutionContext } from './tool-registry-types';

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

            expect(registration.toModelOutput?.({ answer: 'Theme: Dark\nLang: EN' })).toBe('Theme: Dark\nLang: EN');
        });
    });

    describe('batch callback', () => {
        it('hands the whole questions array to requestUserQuestions in one call when provided', async () => {
            const calls: readonly AskUserQuestionRequest[][] = [];
            let next = 0;
            const answers = ['Dark', 'EN'];
            const requestUserQuestions = (requests: readonly AskUserQuestionRequest[]): Promise<string[]> => {
                (calls as AskUserQuestionRequest[][]).push([...requests]);
                const out = requests.map((_, i) => answers[i] ?? '');
                next += requests.length;
                return Promise.resolve(out);
            };
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => Promise.resolve(''),
                requestUserQuestions,
            });
            const input: AskUserInput = {
                question: 'Setup wizard',
                options: [],
                questions: [
                    { question: 'Pick a theme', header: 'Theme', options: [{ label: 'Dark' }] },
                    { question: 'Pick a language', options: [{ label: 'EN' }] },
                ],
            };

            const output = await registration.execute(input, createContext());

            expect(calls).toHaveLength(1);
            expect(calls[0]).toHaveLength(2);
            expect(next).toBe(2);
            expect(output).toEqual({ answer: 'Theme: Dark\nPick a language: EN' });
        });

        it('falls back to the sequential single callback when no batch callback is supplied', async () => {
            const { calls, fn } = createRecordingCallback(['Dark', 'EN']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Setup',
                options: [],
                questions: [
                    { question: 'Theme?', options: [{ label: 'Dark' }] },
                    { question: 'Lang?', options: [{ label: 'EN' }] },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls).toHaveLength(2);
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

    describe('recommended-first ordering', () => {
        it('promotes the recommended option to position 0 in the callback request', async () => {
            const { calls, fn } = createRecordingCallback(['C']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick',
                options: [],
                questions: [
                    {
                        question: 'Which?',
                        recommended: 2,
                        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]?.options).toEqual([{ label: 'C' }, { label: 'A' }, { label: 'B' }]);
        });

        it('leaves the order unchanged when recommended is 0', async () => {
            const { calls, fn } = createRecordingCallback(['A']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick',
                options: [],
                questions: [
                    {
                        question: 'Which?',
                        recommended: 0,
                        options: [{ label: 'A' }, { label: 'B' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]?.options).toEqual([{ label: 'A' }, { label: 'B' }]);
        });

        it('leaves the order unchanged when recommended is absent', async () => {
            const { calls, fn } = createRecordingCallback(['A']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick',
                options: [],
                questions: [
                    {
                        question: 'Which?',
                        options: [{ label: 'A' }, { label: 'B' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]?.options).toEqual([{ label: 'A' }, { label: 'B' }]);
        });

        it('does not forward a recommended key on the callback request', async () => {
            const { calls, fn } = createRecordingCallback(['C']);
            const registration = createAskUserToolRegistration({ requestUserQuestion: fn });
            const input: AskUserInput = {
                question: 'Pick',
                options: [],
                questions: [
                    {
                        question: 'Which?',
                        recommended: 1,
                        options: [{ label: 'A' }, { label: 'B' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(calls[0]).not.toHaveProperty('recommended');
        });
    });

    describe('multiple-select answer join', () => {
        it('passes a multi-selection answer string through labeled for multiple:true', async () => {
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => Promise.resolve('read, write'),
            });
            const input: AskUserInput = {
                question: 'Perms',
                options: [],
                questions: [
                    {
                        question: 'Select all that apply',
                        multiple: true,
                        options: [{ label: 'read' }, { label: 'write' }],
                    },
                ],
            };

            const output = await registration.execute(input, createContext());

            expect(output).toEqual({ answer: 'Select all that apply: read, write' });
        });
    });

    describe('user_input wait mirror (interactive)', () => {
        it('starts a user_input wait before the host callback and resolves it after answer', async () => {
            // Given: deferred interactive host callback + recording wait mirror
            const sequence: string[] = [];
            let releaseAnswer: ((value: string) => void) | undefined;
            const pendingAnswer = new Promise<string>((resolve) => {
                releaseAnswer = resolve;
            });
            const registration = createAskUserToolRegistration({
                requestUserQuestion: async () => {
                    sequence.push('callback');
                    return pendingAnswer;
                },
                userInputWait: {
                    start: async ({ toolCallId }) => {
                        sequence.push(`start:${toolCallId}`);
                    },
                    resolve: async ({ toolCallId }) => {
                        sequence.push(`resolve:${toolCallId}`);
                    },
                },
            });
            const context = createContext();

            // When: execute begins and is still pending on the host
            const executePromise = registration.execute({ question: 'Deploy?', options: ['yes'] }, context);
            await Promise.resolve();
            await Promise.resolve();

            // Then: wait started with the tool call id before the host answered
            expect(sequence).toEqual([`start:${context.toolCallId}`, 'callback']);

            // When: host answers
            releaseAnswer?.('yes');
            const output = await executePromise;

            // Then: wait resolved after answer and answer is returned
            expect(output).toEqual({ answer: 'yes' });
            expect(sequence).toEqual([`start:${context.toolCallId}`, 'callback', `resolve:${context.toolCallId}`]);
        });

        it('resolves the user_input wait through try/finally when the host callback rejects', async () => {
            // Given
            const sequence: string[] = [];
            const registration = createAskUserToolRegistration({
                requestUserQuestion: async () => {
                    sequence.push('callback');
                    throw new Error('host cancelled');
                },
                userInputWait: {
                    start: async ({ toolCallId }) => {
                        sequence.push(`start:${toolCallId}`);
                    },
                    resolve: async ({ toolCallId }) => {
                        sequence.push(`resolve:${toolCallId}`);
                    },
                },
            });
            const context = createContext();

            // When / Then
            await expect(registration.execute({ question: 'Deploy?', options: [] }, context)).rejects.toThrow(
                'host cancelled',
            );
            expect(sequence).toEqual([`start:${context.toolCallId}`, 'callback', `resolve:${context.toolCallId}`]);
        });
    });

    describe('non-interactive mode (--no-tui/--json)', () => {
        it('emits an ask-blocked event and returns the blocked sentinel without awaiting the callback', async () => {
            const events: AskUserQuestionRequest[][] = [];
            // Throws on call so any accidental invocation surfaces as an immediate
            // test failure instead of a silent hang.
            const neverCalled = (): Promise<string> => {
                throw new Error('requestUserQuestion must not be called in nonInteractive mode');
            };
            const registration = createAskUserToolRegistration({
                requestUserQuestion: neverCalled,
                nonInteractive: true,
                onAskBlocked: (event) => {
                    events.push([...event.questions]);
                },
            });
            const input: AskUserInput = {
                question: 'Deploy?',
                options: ['yes', 'no'],
            };

            const output = await registration.execute(input, createContext());

            expect(output).toEqual({ answer: ASK_USER_BLOCKED_ANSWER });
            expect(events).toEqual([[{ question: 'Deploy?', options: ['yes', 'no'] }]]);
        });

        it('does not start a durable user_input wait for the non-interactive sentinel path', async () => {
            // Given
            const waitCalls: string[] = [];
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => {
                    throw new Error('requestUserQuestion must not be called in nonInteractive mode');
                },
                nonInteractive: true,
                userInputWait: {
                    start: async () => {
                        waitCalls.push('start');
                    },
                    resolve: async () => {
                        waitCalls.push('resolve');
                    },
                },
            });

            // When
            const output = await registration.execute({ question: 'Deploy?', options: [] }, createContext());

            // Then
            expect(output).toEqual({ answer: ASK_USER_BLOCKED_ANSWER });
            expect(waitCalls).toEqual([]);
        });

        it('emits recommended-first reordered requests in multi-question mode', async () => {
            const events: AskUserQuestionRequest[][] = [];
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => new Promise(() => undefined),
                nonInteractive: true,
                onAskBlocked: (event) => {
                    events.push([...event.questions]);
                },
            });
            const input: AskUserInput = {
                question: 'Setup',
                options: [],
                questions: [
                    {
                        question: 'Which?',
                        recommended: 2,
                        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
                    },
                ],
            };

            await registration.execute(input, createContext());

            expect(events[0]?.[0]?.options).toEqual([{ label: 'C' }, { label: 'A' }, { label: 'B' }]);
        });

        it('returns the blocked sentinel when no onAskBlocked callback is supplied (no crash)', async () => {
            const registration = createAskUserToolRegistration({
                requestUserQuestion: () => new Promise(() => undefined),
                nonInteractive: true,
            });

            const output = await registration.execute({ question: 'q', options: [] }, createContext());

            expect(output).toEqual({ answer: ASK_USER_BLOCKED_ANSWER });
        });
    });

    describe('schema validation (malformed recommended)', () => {
        it('rejects a recommended index outside the options array', () => {
            const result = askUserQuestionSchema.safeParse({
                question: 'q',
                options: [{ label: 'A' }, { label: 'B' }],
                recommended: 5,
            });

            expect(result.success).toBe(false);
        });

        it('rejects recommended on a free-text question with no options', () => {
            const result = askUserQuestionSchema.safeParse({
                question: 'q',
                recommended: 0,
            });

            expect(result.success).toBe(false);
        });

        it('accepts a valid recommended index', () => {
            const result = askUserQuestionSchema.safeParse({
                question: 'q',
                options: [{ label: 'A' }, { label: 'B' }],
                recommended: 1,
            });

            expect(result.success).toBe(true);
        });

        it('accepts a questions payload via the input schema', () => {
            const result = askUserInputSchema.safeParse({
                question: 'summary',
                options: [],
                questions: [
                    {
                        question: 'pick',
                        recommended: 0,
                        options: [{ label: 'x' }],
                    },
                ],
            });

            expect(result.success).toBe(true);
        });
    });
});
