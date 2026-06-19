import { describe, expect, it } from 'vitest';
import { formatSkillInvocationPrompt, parseChatLine } from './chat-commands.js';

describe('chat command parser', () => {
    it('parses model commands when a provider model shorthand is supplied', () => {
        const action = parseChatLine('/model local/local-echo#fast');

        expect(action).toEqual({
            kind: 'model',
            selection: {
                providerID: 'local',
                modelID: 'local-echo',
                variantID: 'fast',
            },
        });
    });

    it('parses bare and explicit pick model commands as picker requests', () => {
        expect(parseChatLine('/model')).toEqual({
            kind: 'model-pick',
        });
        expect(parseChatLine('/model pick')).toEqual({
            kind: 'model-pick',
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

    it('expands /<known-skill> into a skill action when the name is discovered', () => {
        const known = new Set(['git-master', 'planner']);

        expect(parseChatLine('/git-master', { knownSkillNames: known })).toEqual({
            kind: 'skill',
            name: 'git-master',
            instruction: '',
        });
        expect(parseChatLine('/planner refactor the auth module', { knownSkillNames: known })).toEqual({
            kind: 'skill',
            name: 'planner',
            instruction: 'refactor the auth module',
        });
    });

    it('reserves slash commands take precedence over a same-named skill', () => {
        const known = new Set(['exit', 'model', 'new', 'session', 'tree', 'compact', 'trust']);

        expect(parseChatLine('/exit', { knownSkillNames: known })).toEqual({ kind: 'exit' });
        expect(parseChatLine('/model', { knownSkillNames: known })).toEqual({ kind: 'model-pick' });
        expect(parseChatLine('/new', { knownSkillNames: known })).toEqual({ kind: 'new-session' });
        expect(parseChatLine('/sessions', { knownSkillNames: known })).toEqual({ kind: 'sessions' });
        expect(parseChatLine('/compact', { knownSkillNames: known })).toEqual({ kind: 'compact' });
        expect(parseChatLine('/trust', { knownSkillNames: known })).toEqual({ kind: 'trust', action: 'trust' });
    });

    it('falls through to the unknown-slash path for an undiscovered /<name>', () => {
        const known = new Set(['git-master']);

        expect(parseChatLine('/mystery', { knownSkillNames: known })).toEqual({
            kind: 'unknown-slash',
            command: 'mystery',
        });
        expect(parseChatLine('/mystery')).toEqual({
            kind: 'unknown-slash',
            command: 'mystery',
        });
    });

    it('returns normal prompts when the input is not a command', () => {
        expect(parseChatLine('summarize the mission')).toEqual({
            kind: 'prompt',
            prompt: 'summarize the mission',
        });
    });

    it('parses exit as a no-argument slash command', () => {
        expect(parseChatLine('/exit')).toEqual({
            kind: 'exit',
        });
        expect(parseChatLine('/exit now')).toEqual({
            kind: 'invalid',
            message: '/exit does not accept arguments',
        });
    });

    it('returns unknown slash commands without treating them as prompts', () => {
        expect(parseChatLine('/unknown run this')).toEqual({
            kind: 'unknown-slash',
            command: 'unknown',
        });
    });

    it('parses session navigation commands with optional ids', () => {
        expect(parseChatLine('/new')).toEqual({ kind: 'new-session' });
        expect(parseChatLine('/new session_next')).toEqual({ kind: 'new-session', sessionId: 'session_next' });
        expect(parseChatLine('/session')).toEqual({ kind: 'session' });
        expect(parseChatLine('/session session_prev')).toEqual({ kind: 'session', sessionId: 'session_prev' });
        expect(parseChatLine('/sessions')).toEqual({ kind: 'sessions' });
        expect(parseChatLine('/tree')).toEqual({ kind: 'tree' });
        expect(parseChatLine('/tree session_prev')).toEqual({ kind: 'tree', sessionId: 'session_prev' });
        expect(parseChatLine('/clone')).toEqual({ kind: 'clone' });
        expect(parseChatLine('/clone session_copy')).toEqual({ kind: 'clone', sessionId: 'session_copy' });
    });

    it('parses branch selection and fork commands', () => {
        expect(parseChatLine('/branch entry_leaf')).toEqual({
            kind: 'branch',
            mode: 'select',
            entryId: 'entry_leaf',
        });
        expect(parseChatLine('/branch message_parent continue from this branch')).toEqual({
            kind: 'branch',
            mode: 'continue',
            entryId: 'message_parent',
            prompt: 'continue from this branch',
        });
        expect(parseChatLine('/fork entry_leaf')).toEqual({
            kind: 'fork',
            entryId: 'entry_leaf',
        });
        expect(parseChatLine('/fork entry_leaf session_child')).toEqual({
            kind: 'fork',
            entryId: 'entry_leaf',
            sessionId: 'session_child',
        });
    });

    it('rejects invalid session navigation arguments', () => {
        expect(parseChatLine('/new one two')).toEqual({
            kind: 'invalid',
            message: '/new accepts at most one session id',
        });
        expect(parseChatLine('/branch')).toEqual({
            kind: 'invalid',
            message: '/branch requires an entry id or parent message id',
        });
        expect(parseChatLine('/fork')).toEqual({
            kind: 'invalid',
            message: '/fork requires an entry id',
        });
        expect(parseChatLine('/fork entry_leaf session_child extra')).toEqual({
            kind: 'invalid',
            message: '/fork accepts at most an entry id and optional session id',
        });
    });

    it('rejects empty slash commands before routing', () => {
        expect(parseChatLine('/   ')).toEqual({
            kind: 'invalid',
            message: 'Slash command is empty',
        });
    });
});
