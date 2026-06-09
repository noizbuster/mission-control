import { describe, expect, it } from 'vitest';
import { parseChatInput } from './interactive-chat-command.js';

describe('interactive chat command parser', () => {
    it('parses normal slash and skill inputs', () => {
        expect(parseChatInput('hello')).toEqual({
            type: 'prompt',
            prompt: 'hello',
        });
        expect(parseChatInput('/model local/local-echo')).toEqual({
            type: 'slash',
            commandID: 'model',
            argumentsText: 'local/local-echo',
        });
        expect(parseChatInput('$omo:ulw-plan plan auth')).toEqual({
            type: 'skill',
            skillID: 'omo:ulw-plan',
            argumentsText: 'plan auth',
        });
    });

    it('rejects empty command prefixes', () => {
        expect(parseChatInput('   ')).toEqual({ type: 'empty' });
        expect(parseChatInput('/')).toEqual({
            type: 'invalid',
            message: 'Slash command is empty',
        });
        expect(parseChatInput('/   ')).toEqual({
            type: 'invalid',
            message: 'Slash command is empty',
        });
        expect(parseChatInput('$')).toEqual({
            type: 'invalid',
            message: 'Skill command is empty',
        });
        expect(parseChatInput('$   ')).toEqual({
            type: 'invalid',
            message: 'Skill command is empty',
        });
    });

    it('keeps unknown slash commands parseable for routing errors', () => {
        expect(parseChatInput('/unknown run this')).toEqual({
            type: 'slash',
            commandID: 'unknown',
            argumentsText: 'run this',
        });
    });

    it('rejects invalid skill identifiers', () => {
        expect(parseChatInput('$bad!skill run')).toEqual({
            type: 'invalid',
            message: 'Invalid skill command',
        });
    });
});
