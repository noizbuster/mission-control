import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('OpenAI Responses implementation note', () => {
    it('records exact streaming event names mapped to provider-neutral chunks', async () => {
        // Given
        const note = await readFile(new URL('./openai-responses-mapping.md', import.meta.url), 'utf8');

        // Then
        expect(note).toContain('response.created -> response_started');
        expect(note).toContain('response.output_text.delta -> text_delta');
        expect(note).toContain('response.function_call_arguments.delta -> tool_call_delta');
        expect(note).toContain('response.function_call_arguments.done -> tool_call_completed');
        expect(note).toContain('response.output_item.done -> tool_call_completed');
        expect(note).toContain('response.completed -> response_completed');
        expect(note).toContain('response.failed -> response_failed');
        expect(note).toContain('https://platform.openai.com/docs/guides/migrate-to-responses');
        expect(note).toContain('https://platform.openai.com/docs/guides/streaming-responses');
        expect(note).toContain('https://platform.openai.com/docs/guides/function-calling');
        expect(note).toContain('https://platform.openai.com/docs/api-reference/responses-streaming/response');
    });
});
