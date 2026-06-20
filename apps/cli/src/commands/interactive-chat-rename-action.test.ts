import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    resolveSlashCommandMenuSubmission,
} from './interactive-chat-command-menu.js';
import { runRenameAction, type SessionDisplayNameController } from './interactive-chat-rename-action.js';

type CapturingOutput = {
    readonly write: (text: string) => void;
    readonly text: () => string;
};

function createCapturingOutput(): CapturingOutput {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        text: () => chunks.join(''),
    };
}

function createController(): {
    readonly controller: SessionDisplayNameController;
    readonly name: () => string | undefined;
} {
    let stored: string | undefined;
    return {
        controller: {
            current: () => stored,
            update: (name: string) => {
                stored = name;
            },
        },
        name: () => stored,
    };
}

describe('rename command parser', () => {
    it('parses a single-word session name', () => {
        expect(parseChatLine('/rename my-session')).toEqual({
            kind: 'rename',
            name: 'my-session',
        });
    });

    it('parses a bare /rename with no argument as a nameless rename action', () => {
        expect(parseChatLine('/rename')).toEqual({
            kind: 'rename',
        });
    });

    it('preserves multi-word names as a single name string', () => {
        expect(parseChatLine('/rename multi word name')).toEqual({
            kind: 'rename',
            name: 'multi word name',
        });
    });

    it('trims surrounding whitespace from the name', () => {
        expect(parseChatLine('/rename   spaced   ')).toEqual({
            kind: 'rename',
            name: 'spaced',
        });
    });
});

describe('rename slash command menu', () => {
    // /ren is not a unique prefix: the description filter matches "current" (contains
    // "ren") in /tree, /export, and /clone descriptions. /rena is the shortest unique
    // prefix for /rename.
    it('filters /rena down to only the /rename command', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/rena', state, 20);

        expect(view.open).toBe(true);
        expect(view.totalCount).toBe(1);
        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(['/rename']);
    });

    it('resolves a partial /rena submission to /rename', () => {
        const state = createSlashCommandMenuState();
        expect(resolveSlashCommandMenuSubmission('/rena', state)).toBe('/rename');
    });

    it('includes /rename among the /ren matches', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/ren', state, 20);

        expect(view.open).toBe(true);
        expect(view.visibleChoices.map((choice) => choice.id)).toContain('/rename');
    });
});

describe('rename action handler', () => {
    it('updates the stored name and writes a confirmation when a name is supplied', async () => {
        const output = createCapturingOutput();
        const { controller, name } = createController();

        await runRenameAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            { kind: 'rename', name: 'my-session' },
            controller,
            undefined,
        );

        expect(name()).toBe('my-session');
        expect(output.text()).toContain('Session renamed to: my-session');
    });

    it('writes the current name when no name is supplied and a name is set', async () => {
        const output = createCapturingOutput();
        const { controller } = createController();
        controller.update('existing-name');

        await runRenameAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            { kind: 'rename' },
            controller,
            undefined,
        );

        expect(output.text()).toContain('Session name: existing-name');
    });

    it('writes that the session is unnamed when no name is set and no name is supplied', async () => {
        const output = createCapturingOutput();
        const { controller } = createController();

        await runRenameAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            { kind: 'rename' },
            controller,
            undefined,
        );

        expect(output.text()).toContain('Session is unnamed');
    });

    it('still writes confirmation when the controller is undefined', async () => {
        const output = createCapturingOutput();

        await runRenameAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            { kind: 'rename', name: 'lonely' },
            undefined,
            undefined,
        );

        expect(output.text()).toContain('Session renamed to: lonely');
    });
});
