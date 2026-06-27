import { splitCommandParts } from './chat-command-parts.js';
import type { ChatLineAction } from './chat-commands.js';

export function parseSessionSlashCommand(command: string, input: string): ChatLineAction | undefined {
    switch (command) {
        case 'new':
            return parseOptionalSessionCommand('new-session', 'new', input);
        case 'clear':
            return parseOptionalSessionCommand('clear', 'clear', input);
        case 'session':
            return parseSessionCommand(input);
        case 'sessions':
            return parseNoArgumentSessionCommand('sessions', input);
        case 'tree':
            return parseOptionalSessionCommand('tree', 'tree', input);
        case 'branch':
            return parseBranchCommand(input);
        case 'fork':
            return parseForkCommand(input);
        case 'clone':
            return parseOptionalSessionCommand('clone', 'clone', input);
        default:
            return undefined;
    }
}

function parseNoArgumentSessionCommand(kind: 'sessions', input: string): ChatLineAction {
    if (input.length > 0) {
        return { kind: 'invalid', message: `/${kind} does not accept arguments` };
    }
    return { kind };
}

function parseBranchCommand(input: string): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: '/branch requires an entry id or parent message id' };
    }
    if (parts.tail.length === 0) {
        return {
            kind: 'branch',
            mode: 'select',
            entryId: parts.head,
        };
    }
    return {
        kind: 'branch',
        mode: 'continue',
        entryId: parts.head,
        prompt: parts.tail,
    };
}

function parseForkCommand(input: string): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: '/fork requires an entry id' };
    }
    const target = splitCommandParts(parts.tail);
    if (target.tail.length > 0) {
        return { kind: 'invalid', message: '/fork accepts at most an entry id and optional session id' };
    }
    return {
        kind: 'fork',
        entryId: parts.head,
        ...(target.head.length > 0 ? { sessionId: target.head } : {}),
    };
}

function parseOptionalSessionCommand(
    kind: 'new-session' | 'session' | 'tree' | 'clone' | 'clear',
    command: 'new' | 'session' | 'tree' | 'clone' | 'clear',
    input: string,
): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.tail.length > 0) {
        return { kind: 'invalid', message: `/${command} accepts at most one session id` };
    }
    return parts.head.length === 0 ? { kind } : { kind, sessionId: parts.head };
}

function parseSessionCommand(input: string): ChatLineAction {
    const parts = splitCommandParts(input);
    if (parts.tail.length > 0) {
        return { kind: 'invalid', message: '/session accepts at most one session id' };
    }
    return parts.head.length === 0
        ? { kind: 'session-picker' }
        : { kind: 'session', sessionId: parts.head };
}
