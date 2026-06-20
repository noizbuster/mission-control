import type { AgentMessage } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildCompactionRequestMessages } from './interactive-chat-compact.js';

describe('buildCompactionRequestMessages', () => {
    const history: readonly AgentMessage[] = [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'first result' },
    ];

    it('uses the base system prompt with no focus directive when instructions are omitted', () => {
        const messages = buildCompactionRequestMessages(history);
        const systemMessages = messages.filter((message) => message.role === 'system');
        expect(systemMessages).toHaveLength(1);
        expect(systemMessages[0]?.content).toContain('Summarize the current session');
        expect(systemMessages[0]?.content).not.toContain('Focus on:');
    });

    it('appends a Focus directive when instructions are provided', () => {
        const messages = buildCompactionRequestMessages(history, 'focus on API changes');
        const systemMessage = messages.find((message) => message.role === 'system');
        expect(systemMessage?.content).toContain('Summarize the current session');
        expect(systemMessage?.content).toContain('Focus on: focus on API changes');
    });

    it('omits the focus directive when instructions are an empty string', () => {
        const messages = buildCompactionRequestMessages(history, '');
        const systemMessage = messages.find((message) => message.role === 'system');
        expect(systemMessage?.content).not.toContain('Focus on:');
    });

    it('keeps the trailing summary request and preserves visible user and assistant history', () => {
        const messages = buildCompactionRequestMessages(history, 'preserve tests');
        expect(messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ role: 'user', content: 'first task' }),
                expect.objectContaining({ role: 'assistant', content: 'first result' }),
                expect.objectContaining({
                    role: 'user',
                    content: 'Write a concise continuation summary for this session.',
                }),
            ]),
        );
    });

    it('drops tool and inline-system messages from the visible history', () => {
        const withToolAndSystem: readonly AgentMessage[] = [
            { role: 'system', content: 'inline system guidance' },
            { role: 'user', content: 'first task' },
            { role: 'assistant', content: 'first result' },
            { role: 'tool', toolCallId: 'call_1', status: 'completed', output: 'tool output' },
        ];
        const messages = buildCompactionRequestMessages(withToolAndSystem);
        const roles = messages.map((message) => message.role);
        expect(roles.filter((role) => role === 'system')).toHaveLength(1);
        expect(roles).not.toContain('tool');
    });
});
