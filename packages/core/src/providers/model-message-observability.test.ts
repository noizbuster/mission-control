import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { redactModelMessagesForObservability } from './model-message-observability.js';
import { createObservabilityRedactor } from './observability-redactor.js';
import { createHash } from 'node:crypto';

describe('model message observability', () => {
    it('replaces eval tool input with its digest while preserving non-eval message parts', () => {
        // Given
        const evalInput = { cells: [{ language: 'js', code: 'const result = 40 + 2' }] };
        const messages = modelMessageSchema.array().parse([
            { role: 'user', content: 'inspect then calculate' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'call_read',
                        toolName: 'read',
                        input: { path: 'README.md' },
                    },
                    {
                        type: 'tool-call',
                        toolCallId: 'call_eval',
                        toolName: 'eval',
                        input: evalInput,
                    },
                ],
            },
        ]);
        const digest = createHash('sha256').update(JSON.stringify(evalInput)).digest('hex');

        // When
        const observable = redactModelMessagesForObservability(messages, createObservabilityRedactor());

        // Then
        expect(observable).toEqual([
            { role: 'user', content: 'inspect then calculate' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'call_read',
                        toolName: 'read',
                        input: { path: 'README.md' },
                    },
                    {
                        type: 'tool-call',
                        toolCallId: 'call_eval',
                        toolName: 'eval',
                        input: { redacted: true, sha256: digest },
                    },
                ],
            },
        ]);
    });
});
