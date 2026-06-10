import { describe, expect, it } from 'vitest';
import { parseOpenAIResponsesSseEvents } from './openai-responses-http-transport.js';

describe('OpenAI Responses SSE transport parsing', () => {
    it('parses complete SSE data frames and preserves partial remainders', () => {
        // Given
        const sse = [
            'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"hel"}',
            '',
            'data: {"type":"response.output_text.delta","sequence_number":2,"delta":"lo"}',
            '',
            'data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_1"}}',
        ].join('\n');

        // When
        const parsed = parseOpenAIResponsesSseEvents(sse);

        // Then
        expect(parsed.events).toEqual([
            { type: 'response.output_text.delta', sequence_number: 1, delta: 'hel' },
            { type: 'response.output_text.delta', sequence_number: 2, delta: 'lo' },
        ]);
        expect(parsed.remainder).toBe(
            'data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_1"}}',
        );
    });

    it('ignores done frames and rejects malformed JSON frames', () => {
        // Given
        const done = parseOpenAIResponsesSseEvents('data: [DONE]\n\n');

        // When / Then
        expect(done.events).toEqual([]);
        expect(() => parseOpenAIResponsesSseEvents('data: {"type":\n\n')).toThrow(
            'OpenAI SSE frame contained invalid JSON',
        );
    });
});
