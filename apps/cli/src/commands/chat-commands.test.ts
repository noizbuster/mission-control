import { describe, expect, it } from 'vitest';
import { chatActionShowsWorkingStatus, formatSkillInvocationPrompt, parseChatLine } from './chat-commands';

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
        expect(parseChatLine('$planner')).toEqual({
            kind: 'skill',
            name: 'planner',
            instruction: '',
        });
        expect(parseChatLine('$git-master')).toEqual({
            kind: 'skill',
            name: 'git-master',
            instruction: '',
        });
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

    it('parses workflow invocations when input starts with a hash', () => {
        expect(parseChatLine('#planner plan X')).toEqual({
            kind: 'workflow',
            name: 'planner',
            prompt: 'plan X',
        });
        expect(parseChatLine('#default hello')).toEqual({
            kind: 'workflow',
            name: 'default',
            prompt: 'hello',
        });
    });

    it('accepts any valid-format workflow name when no known set is provided', () => {
        expect(parseChatLine('#unknown-name do the thing')).toEqual({
            kind: 'workflow',
            name: 'unknown-name',
            prompt: 'do the thing',
        });
    });

    it('accepts known workflow names when a known set is provided', () => {
        const known = new Set(['planner', 'default']);

        expect(parseChatLine('#planner plan X', { knownWorkflowNames: known })).toEqual({
            kind: 'workflow',
            name: 'planner',
            prompt: 'plan X',
        });
    });

    it('rejects an empty workflow name after the hash prefix', () => {
        expect(parseChatLine('#')).toEqual({
            kind: 'invalid',
            message: 'Workflow command is empty',
        });
        expect(parseChatLine('#   ')).toEqual({
            kind: 'invalid',
            message: 'Workflow command is empty',
        });
    });

    it('rejects workflow names with invalid characters', () => {
        expect(parseChatLine('#invalid!name prompt')).toEqual({
            kind: 'invalid',
            message: 'Invalid workflow command',
        });
    });

    it('rejects unknown workflow names when a known set is provided', () => {
        const known = new Set(['planner', 'default']);

        expect(parseChatLine('#unknown-name prompt', { knownWorkflowNames: known })).toEqual({
            kind: 'invalid',
            message: 'Unknown workflow "unknown-name"',
        });
    });

    it('treats /<name> as unknown-slash even when the name matches a skill (skills are $-only)', () => {
        expect(parseChatLine('/git-master')).toEqual({
            kind: 'unknown-slash',
            command: 'git-master',
        });
        expect(parseChatLine('/planner refactor the auth module')).toEqual({
            kind: 'unknown-slash',
            command: 'planner',
        });
    });

    it('falls through to the unknown-slash path for an undiscovered /<name>', () => {
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

    it('treats a leading space before / as an intentional escape from slash commands', () => {
        expect(parseChatLine(' /help')).toEqual({
            kind: 'prompt',
            prompt: '/help',
        });
        expect(parseChatLine(' /exit')).toEqual({
            kind: 'prompt',
            prompt: '/exit',
        });
        expect(parseChatLine(' /model local/local-echo')).toEqual({
            kind: 'prompt',
            prompt: '/model local/local-echo',
        });
        expect(parseChatLine('\t/help')).toEqual({
            kind: 'prompt',
            prompt: '/help',
        });
    });

    it('still runs slash commands when / is at column 0', () => {
        expect(parseChatLine('/help')).toEqual({ kind: 'help' });
        expect(parseChatLine('/exit')).toEqual({ kind: 'exit' });
    });

    it('treats a leading space before $, #, and ! as an intentional escape', () => {
        expect(parseChatLine(' $planner draft')).toEqual({
            kind: 'prompt',
            prompt: '$planner draft',
        });
        expect(parseChatLine(' #planner plan X')).toEqual({
            kind: 'prompt',
            prompt: '#planner plan X',
        });
        expect(parseChatLine(' !ls')).toEqual({
            kind: 'prompt',
            prompt: '!ls',
        });
        expect(parseChatLine(' !!echo hi')).toEqual({
            kind: 'prompt',
            prompt: '!!echo hi',
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

    it('dispatches /agents to the agents action with parsed subcommand', () => {
        expect(parseChatLine('/agents')).toEqual({
            kind: 'agents',
            agents: { kind: 'dashboard' },
        });
        expect(parseChatLine('/agents list')).toEqual({
            kind: 'agents',
            agents: { kind: 'list' },
        });
        expect(parseChatLine('/agents dashboard')).toEqual({
            kind: 'agents',
            agents: { kind: 'dashboard' },
        });
        expect(parseChatLine('/agents reload')).toEqual({
            kind: 'agents',
            agents: { kind: 'reload' },
        });
        expect(parseChatLine('/agents oracle')).toEqual({
            kind: 'agents',
            agents: { kind: 'show', name: 'oracle' },
        });
        expect(parseChatLine('/agents disable oracle')).toEqual({
            kind: 'agents',
            agents: { kind: 'disable', name: 'oracle' },
        });
    });

    it('parses /models as the role-assignment overlay action with no arguments', () => {
        expect(parseChatLine('/models')).toEqual({ kind: 'models' });
    });

    it('rejects /models with arguments as invalid', () => {
        expect(parseChatLine('/models foo')).toEqual({
            kind: 'invalid',
            message: '/models opens the role-assignment overlay and takes no arguments',
        });
    });

    it('keeps /model and /model pick working alongside /models (regression guard)', () => {
        expect(parseChatLine('/model')).toEqual({ kind: 'model-pick' });
        expect(parseChatLine('/model pick')).toEqual({ kind: 'model-pick' });
    });

    it('parses session navigation commands with optional ids', () => {
        expect(parseChatLine('/new')).toEqual({ kind: 'new-session' });
        expect(parseChatLine('/new session_next')).toEqual({ kind: 'new-session', sessionId: 'session_next' });
        expect(parseChatLine('/session')).toEqual({ kind: 'session-picker' });
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

    it('parses /continue as a no-argument work-resume command', () => {
        expect(parseChatLine('/continue')).toEqual({ kind: 'continue' });
        expect(parseChatLine('/continue resume the run')).toEqual({
            kind: 'invalid',
            message: '/continue does not accept arguments',
        });
    });

    it('parses /retry as a no-argument failed-run-rerun command', () => {
        expect(parseChatLine('/retry')).toEqual({ kind: 'retry' });
        expect(parseChatLine('/retry now')).toEqual({
            kind: 'invalid',
            message: '/retry does not accept arguments',
        });
    });

    it('parses /kick as a no-argument stalled-connection reset command', () => {
        expect(parseChatLine('/kick')).toEqual({ kind: 'kick' });
        expect(parseChatLine('/kick now')).toEqual({
            kind: 'invalid',
            message: '/kick does not accept arguments',
        });
    });

    it('parses /resume as a no-argument session attach command', () => {
        expect(parseChatLine('/resume')).toEqual({ kind: 'resume' });
    });

    it('keeps /branch <id> <prompt> on the continue branch mode (N1 regression guard)', () => {
        expect(parseChatLine('/branch msg_parent continue from this branch')).toEqual({
            kind: 'branch',
            mode: 'continue',
            entryId: 'msg_parent',
            prompt: 'continue from this branch',
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

    it('dispatches /skills reload to the skills reload action', () => {
        expect(parseChatLine('/skills reload')).toEqual({
            kind: 'skills',
            skills: { kind: 'reload' },
        });
    });

    it('rejects bare /skills as invalid (no list/dashboard subcommand)', () => {
        expect(parseChatLine('/skills')).toEqual({
            kind: 'skills',
            skills: { kind: 'invalid', message: '/skills requires a subcommand: reload' },
        });
    });

    it('rejects /skills reload with trailing arguments', () => {
        expect(parseChatLine('/skills reload force')).toEqual({
            kind: 'skills',
            skills: { kind: 'invalid', message: '/skills reload does not accept arguments' },
        });
    });

    it('rejects unknown /skills subcommands as invalid', () => {
        expect(parseChatLine('/skills list')).toEqual({
            kind: 'skills',
            skills: { kind: 'invalid', message: '/skills supports: reload' },
        });
    });

    it('parses /mission as the mission control panel action with no arguments', () => {
        expect(parseChatLine('/mission')).toEqual({ kind: 'mission' });
    });

    it('rejects /mission with arguments as invalid', () => {
        expect(parseChatLine('/mission runs')).toEqual({
            kind: 'invalid',
            message: '/mission opens the mission control panel and takes no arguments',
        });
    });

    it('rejects /mission with multiple trailing arguments', () => {
        expect(parseChatLine('/mission runs jobs')).toEqual({
            kind: 'invalid',
            message: '/mission opens the mission control panel and takes no arguments',
        });
    });

    it('accepts /mission with trailing whitespace as valid', () => {
        expect(parseChatLine('/mission   ')).toEqual({ kind: 'mission' });
    });
});

describe('chatActionShowsWorkingStatus', () => {
    it('keeps model and session pickers idle so overlays own the keyboard', () => {
        expect(chatActionShowsWorkingStatus('model-pick')).toBe(false);
        expect(chatActionShowsWorkingStatus('model-list')).toBe(false);
        expect(chatActionShowsWorkingStatus('model')).toBe(false);
        expect(chatActionShowsWorkingStatus('models')).toBe(false);
        expect(chatActionShowsWorkingStatus('session-picker')).toBe(false);
        expect(chatActionShowsWorkingStatus('sessions')).toBe(false);
        expect(chatActionShowsWorkingStatus('agents')).toBe(false);
        expect(chatActionShowsWorkingStatus('approval')).toBe(false);
    });

    it('marks agent-work actions as generating', () => {
        expect(chatActionShowsWorkingStatus('prompt')).toBe(true);
        expect(chatActionShowsWorkingStatus('skill')).toBe(true);
        expect(chatActionShowsWorkingStatus('workflow')).toBe(true);
        expect(chatActionShowsWorkingStatus('bash')).toBe(true);
        expect(chatActionShowsWorkingStatus('continue')).toBe(true);
        expect(chatActionShowsWorkingStatus('retry')).toBe(true);
        expect(chatActionShowsWorkingStatus('compact')).toBe(true);
    });
});
