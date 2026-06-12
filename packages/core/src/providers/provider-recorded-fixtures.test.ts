import { describe, expect, it } from 'vitest';
import { parseAnthropicMessagesSseEvents } from './anthropic/anthropic-messages-http-transport.js';
import { parseGeminiGenerateContentSseEvents } from './google/gemini-generate-content-http-transport.js';
import { parseOpenAIResponsesSseEvents } from './openai/openai-responses-http-transport.js';
import { parseOpenAICompatibleSseEvents } from './openai-compatible/openai-compatible-http-transport.js';
import { readdir, readFile } from 'node:fs/promises';

type SseParseResult = {
    readonly events: readonly unknown[];
    readonly remainder: string;
};

type FixtureSpec = {
    readonly file: string;
    readonly parse: (text: string) => SseParseResult;
    readonly assertEvents: (events: readonly unknown[]) => void;
};

const FIXTURE_DIRECTORY = new URL('./fixtures/', import.meta.url);

const FIXTURE_SPECS = [
    {
        file: 'anthropic-messages.sse',
        parse: parseAnthropicMessagesSseEvents,
        assertEvents(events) {
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: 'message_start' }),
                    expect.objectContaining({
                        type: 'content_block_delta',
                        delta: expect.objectContaining({ type: 'text_delta', text: 'README' }),
                    }),
                    expect.objectContaining({
                        type: 'content_block_start',
                        content_block: expect.objectContaining({
                            type: 'tool_use',
                            id: 'toolu_fixture_1',
                            name: 'repo_read',
                        }),
                    }),
                    expect.objectContaining({
                        type: 'content_block_delta',
                        delta: expect.objectContaining({
                            type: 'input_json_delta',
                            partial_json: '{"path":"README.md"}',
                        }),
                    }),
                    expect.objectContaining({
                        type: 'message_delta',
                        delta: expect.objectContaining({ stop_reason: 'tool_use' }),
                    }),
                ]),
            );
        },
    },
    {
        file: 'gemini-generate-content.sse',
        parse: parseGeminiGenerateContentSseEvents,
        assertEvents(events) {
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        responseId: 'gemini_resp_fixture',
                        candidates: expect.arrayContaining([
                            expect.objectContaining({
                                content: expect.objectContaining({
                                    parts: expect.arrayContaining([
                                        expect.objectContaining({ text: 'need search' }),
                                        expect.objectContaining({
                                            functionCall: expect.objectContaining({
                                                id: 'call_search_fixture',
                                                name: 'repo_search',
                                            }),
                                        }),
                                    ]),
                                }),
                            }),
                        ]),
                    }),
                ]),
            );
        },
    },
    {
        file: 'openai-compatible.sse',
        parse: parseOpenAICompatibleSseEvents,
        assertEvents(events) {
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: 'chatcmpl_fixture',
                        choices: expect.arrayContaining([
                            expect.objectContaining({
                                delta: expect.objectContaining({ content: 'need README' }),
                            }),
                        ]),
                    }),
                    expect.objectContaining({
                        id: 'chatcmpl_fixture',
                        choices: expect.arrayContaining([
                            expect.objectContaining({
                                delta: expect.objectContaining({
                                    tool_calls: expect.arrayContaining([
                                        expect.objectContaining({
                                            id: 'call_read_fixture',
                                            function: expect.objectContaining({
                                                name: 'repo_read',
                                                arguments: '{"path":"README.md"}',
                                            }),
                                        }),
                                    ]),
                                }),
                                finish_reason: 'tool_calls',
                            }),
                        ]),
                    }),
                ]),
            );
        },
    },
    {
        file: 'openai-responses.sse',
        parse: parseOpenAIResponsesSseEvents,
        assertEvents(events) {
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: 'response.created' }),
                    expect.objectContaining({ type: 'response.output_text.delta', delta: 'need README' }),
                    expect.objectContaining({
                        type: 'response.function_call_arguments.delta',
                        item_id: 'fc_fixture_1',
                        delta: '{"path"',
                    }),
                    expect.objectContaining({
                        type: 'response.function_call_arguments.done',
                        item_id: 'fc_fixture_1',
                        arguments: '{"path":"README.md"}',
                        name: 'repo_read',
                    }),
                    expect.objectContaining({
                        type: 'response.output_item.done',
                        item: expect.objectContaining({
                            type: 'function_call',
                            id: 'fc_fixture_1',
                            call_id: 'call_read_fixture',
                            name: 'repo_read',
                        }),
                    }),
                ]),
            );
        },
    },
] as const satisfies readonly FixtureSpec[];

const FORBIDDEN_PATTERNS = [
    /sk-/i,
    /ghp_/i,
    /github_pat_/i,
    /AKIA/i,
    /BEGIN PRIVATE KEY/i,
    /Bearer\s+[A-Za-z0-9._-]{8,}/i,
    /OPENAI_API_KEY/,
    /ANTHROPIC_API_KEY/,
    /GOOGLE_API_KEY/,
    /OPENROUTER_API_KEY/,
] as const;

describe('provider recorded fixtures', () => {
    it.each(FIXTURE_SPECS)('parses sanitized fixture $file', async ({ file, parse, assertEvents }) => {
        // Given
        const text = await readFixture(file);

        // When
        const parsed = parse(`${text}\n`);

        // Then
        expect(parsed.remainder).toBe('');
        expect(parsed.events.length).toBeGreaterThan(0);
        assertEvents(parsed.events);
    });

    it('keeps recorded fixtures ASCII-only and free of secret-like patterns', async () => {
        // Given
        const fileNames = (await readdir(FIXTURE_DIRECTORY)).sort();

        expect(fileNames).toEqual(FIXTURE_SPECS.map(({ file }) => file).sort());
        for (const fileName of fileNames) {
            const contents = await readFixture(fileName);
            expect(isAscii(contents)).toBe(true);
            for (const pattern of FORBIDDEN_PATTERNS) {
                expect(contents).not.toMatch(pattern);
            }
        }
    });
});

async function readFixture(file: string): Promise<string> {
    return readFile(new URL(file, FIXTURE_DIRECTORY), 'utf8');
}

function isAscii(text: string): boolean {
    return [...text].every((character) => character.charCodeAt(0) <= 0x7f);
}
