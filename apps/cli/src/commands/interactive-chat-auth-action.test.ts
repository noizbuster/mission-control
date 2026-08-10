import type { ModelProviderSelection } from '@mission-control/protocol';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    resolveSlashCommandMenuSubmission,
} from '@mission-control/tui/state';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAuthStore } from '../auth-store';
import { runAuthCommand } from './auth';
import { parseChatLine } from './chat-commands';
import type { CodingActionContext } from './interactive-chat-action-context';
import { runAuthChatAction } from './interactive-chat-auth-action';

vi.mock('./auth.js', () => ({
    runAuthCommand: vi.fn(),
}));

const mockedRunAuthCommand = vi.mocked(runAuthCommand);

const baseSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

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

function createCodingContext(authStore?: ProviderAuthStore): CodingActionContext {
    return {
        provider: undefined,
        sessionId: undefined,
        workspaceRoot: undefined,
        commandExecutor: undefined,
        emitEvent: undefined,
        observeStoredEvent: undefined,
        nextTurnId: () => 'turn_auth_test',
        sessionStore: undefined,
        activeTurn: undefined,
        useTui: false,
        ...(authStore !== undefined ? { authStore } : {}),
    };
}

describe('auth command parser via parseChatLine', () => {
    it('parses /auth login into an auth action', () => {
        expect(parseChatLine('/auth login --provider local --api-key k')).toMatchObject({
            kind: 'auth',
            auth: {
                kind: 'login',
                args: {
                    command: 'auth-login',
                    authProviderID: 'local',
                    authApiKey: 'k',
                },
            },
        });
    });

    it('parses /auth list and /auth logout', () => {
        expect(parseChatLine('/auth list')).toMatchObject({
            kind: 'auth',
            auth: { kind: 'list', args: { command: 'auth-list' } },
        });
        expect(parseChatLine('/auth logout --provider local')).toMatchObject({
            kind: 'auth',
            auth: {
                kind: 'logout',
                args: { command: 'auth-logout', authProviderID: 'local' },
            },
        });
    });

    it('rejects bare /auth with usage', () => {
        expect(parseChatLine('/auth')).toEqual({
            kind: 'auth',
            auth: {
                kind: 'invalid',
                message: '/auth requires a subcommand: login, list, logout',
            },
        });
    });
});

describe('auth slash command menu', () => {
    it('filters /auth down to login list logout choices', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/auth', state, 20);

        expect(view.open).toBe(true);
        expect(view.visibleChoices.map((choice) => choice.id).sort()).toEqual([
            '/auth list',
            '/auth login',
            '/auth logout',
        ]);
    });

    it('resolves the first ranked /auth menu entry on submit', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/auth', state, 20);
        // Menu closes once a space is typed (argument-taking phase); selection happens on bare /auth.
        expect(view.open).toBe(true);
        expect(view.visibleChoices[0]?.id).toBeDefined();
        expect(resolveSlashCommandMenuSubmission('/auth', state)).toBe(view.visibleChoices[0]?.insertText.trimEnd());
    });
});

describe('runAuthChatAction', () => {
    it('writes invalid usage without calling runAuthCommand', async () => {
        mockedRunAuthCommand.mockReset();
        const output = createCapturingOutput();

        await runAuthChatAction(output, baseSelection, createCodingContext(), {
            kind: 'invalid',
            message: '/auth requires a subcommand: login, list, logout',
        });

        expect(mockedRunAuthCommand).not.toHaveBeenCalled();
        expect(output.text()).toBe('/auth requires a subcommand: login, list, logout\n');
    });

    it('delegates list to runAuthCommand with the coding auth store', async () => {
        mockedRunAuthCommand.mockReset();
        mockedRunAuthCommand.mockResolvedValue('No provider credentials configured\n');
        const store = { id: 'store' } as unknown as ProviderAuthStore;
        const output = createCapturingOutput();
        const command = parseChatLine('/auth list');
        if (command.kind !== 'auth') {
            throw new Error('expected auth action');
        }

        await runAuthChatAction(output, baseSelection, createCodingContext(store), command.auth);

        expect(mockedRunAuthCommand).toHaveBeenCalledTimes(1);
        expect(mockedRunAuthCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'auth-list' }), {
            store,
        });
        expect(output.text()).toBe('No provider credentials configured\n');
    });

    it('writes Auth command failed when runAuthCommand rejects', async () => {
        mockedRunAuthCommand.mockReset();
        mockedRunAuthCommand.mockRejectedValue(new Error('Provider credential not configured: local'));
        const output = createCapturingOutput();
        const command = parseChatLine('/auth logout --provider local');
        if (command.kind !== 'auth') {
            throw new Error('expected auth action');
        }

        await runAuthChatAction(output, baseSelection, createCodingContext(), command.auth);

        expect(output.text()).toBe('Auth command failed: Provider credential not configured: local\n');
    });
});
