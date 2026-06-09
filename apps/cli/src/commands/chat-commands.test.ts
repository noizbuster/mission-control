import { describe, expect, it } from 'vitest';
import { formatSkillInvocationPrompt, parseChatLine } from './chat-commands.js';

describe('chat command parser', () => {
    it('parses model commands when a provider model shorthand is supplied', () => {
        const action = parseChatLine('/model anthropic/claude-3-5-haiku-20241022');

        expect(action).toEqual({
            kind: 'model',
            selection: {
                providerID: 'anthropic',
                modelID: 'claude-3-5-haiku-20241022',
            },
        });
    });

    it('parses skill invocations when input starts with a dollar sign', () => {
        const action = parseChatLine('$planner draft a rollout checklist');

        expect(action).toEqual({
            kind: 'skill',
            name: 'planner',
            instruction: 'draft a rollout checklist',
        });
        if (action.kind !== 'skill') {
            throw new Error('expected skill action');
        }
        expect(formatSkillInvocationPrompt(action)).toBe('Invoke skill "planner": draft a rollout checklist');
    });

    it('returns normal prompts when the input is not a command', () => {
        expect(parseChatLine('summarize the mission')).toEqual({
            kind: 'prompt',
            prompt: 'summarize the mission',
        });
    });

    it('returns unknown slash commands without treating them as prompts', () => {
        expect(parseChatLine('/unknown run this')).toEqual({
            kind: 'unknown-slash',
            command: 'unknown',
        });
    });

    it('rejects empty slash commands before routing', () => {
        expect(parseChatLine('/   ')).toEqual({
            kind: 'invalid',
            message: 'Slash command is empty',
        });
    });
});
