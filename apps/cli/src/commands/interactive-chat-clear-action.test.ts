import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { runClearAction } from './interactive-chat-clear-action.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    resolveSlashCommandMenuSubmission,
} from './interactive-chat-command-menu.js';
import type { SessionNavigationController, SessionNavigationResult } from './interactive-chat-session-navigation.js';
import type { UndoRedoConversationController } from './interactive-chat-undo-redo-action.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const baseSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

function createNavigationController(
    startNewSession: SessionNavigationController['startNewSession'],
): SessionNavigationController {
    return {
        startNewSession,
        switchSession: vi.fn(),
        listSessions: vi.fn(),
        showSession: vi.fn(),
        showTree: vi.fn(),
        forkSession: vi.fn(),
        cloneSession: vi.fn(),
        selectBranch: vi.fn(),
    };
}

function createUndoRedoController(): UndoRedoConversationController & {
    readonly replacedWith: () => string | undefined;
} {
    let replaced: string | undefined;
    return {
        readOutputText: () => '',
        replaceOutputText: (next: string) => {
            replaced = next;
        },
        getStack: () => ({ undonePairs: [] }),
        setStack: () => undefined,
        replacedWith: () => replaced,
    };
}

function createCodingContext(overrides: {
    readonly sessionNavigation?: SessionNavigationController;
    readonly undoRedo?: UndoRedoConversationController;
}): CodingActionContext {
    return {
        provider: undefined,
        sessionId: undefined,
        workspaceRoot: undefined,
        commandExecutor: undefined,
        emitEvent: undefined,
        observeStoredEvent: undefined,
        nextTurnId: () => 'turn_clear_test',
        sessionStore: undefined,
        activeTurn: undefined,
        ...(overrides.sessionNavigation !== undefined ? { sessionNavigation: overrides.sessionNavigation } : {}),
        ...(overrides.undoRedo !== undefined ? { undoRedo: overrides.undoRedo } : {}),
    };
}

describe('clear command parser', () => {
    it('parses /clear as a clear action', () => {
        expect(parseChatLine('/clear')).toEqual({ kind: 'clear' });
    });

    it('parses /clear with an optional session id', () => {
        expect(parseChatLine('/clear my-session')).toEqual({ kind: 'clear', sessionId: 'my-session' });
    });

    it('rejects more than one session id argument', () => {
        expect(parseChatLine('/clear one two')).toEqual({
            kind: 'invalid',
            message: '/clear accepts at most one session id',
        });
    });
});

describe('clear slash command menu', () => {
    it('filters /cle down to the /clear command', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/cle', state, 20);

        expect(view.open).toBe(true);
        expect(view.totalCount).toBe(1);
        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(['/clear']);
    });

    it('resolves a partial /cle submission to /clear', () => {
        const state = createSlashCommandMenuState();
        expect(resolveSlashCommandMenuSubmission('/cle', state)).toBe('/clear');
    });

    it('does not collide /cle with /clone (clone has no cle substring)', () => {
        const view = createSlashCommandMenuView('/cle', createSlashCommandMenuState(), 20);
        expect(view.visibleChoices.map((choice) => choice.id)).not.toContain('/clone');
    });
});

describe('runClearAction', () => {
    it('creates a new session via sessionNavigation.startNewSession', async () => {
        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: session_new\n',
            sessionId: 'session_new',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(startNewSession).toHaveBeenCalledWith({ modelProviderSelection: baseSelection });
    });

    it('passes the optional session id to startNewSession', async () => {
        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: custom-id\n',
            sessionId: 'custom-id',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear', sessionId: 'custom-id' },
        );

        expect(startNewSession).toHaveBeenCalledWith({
            modelProviderSelection: baseSelection,
            sessionId: 'custom-id',
        });
    });

    it('clears the display by calling replaceOutputText with empty string', async () => {
        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: session_fresh\n',
            sessionId: 'session_fresh',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(undoRedoController.replacedWith()).toBe('');
    });

    it('writes a brief system message with the new session id', async () => {
        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: session_fresh\n',
            sessionId: 'session_fresh',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(output.text()).toContain('Screen cleared. New session: session_fresh');
    });

    it('returns a ChatActionResult with the new session id', async () => {
        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: session_result\n',
            sessionId: 'session_result',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        const result = await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(result.sessionId).toBe('session_result');
        expect(result.modelProviderSelection).toEqual(baseSelection);
    });

    it('does not clear the display when session navigation is unavailable', async () => {
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        const result = await runClearAction(
            output,
            createCodingContext({ undoRedo: undoRedoController }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(undoRedoController.replacedWith()).toBeUndefined();
        expect(output.text()).toContain('Session navigation is unavailable');
        expect(result.sessionId).toBeUndefined();
    });
});

describe('runClearAction preserves old session log', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'mctrl-clear-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('does not delete the old session JSONL file', async () => {
        const oldSessionPath = join(tempDir, 'session_old.jsonl');
        writeFileSync(oldSessionPath, '{"type":"session.started"}\n');

        const startNewSession = vi.fn().mockResolvedValue({
            message: 'Started new session: session_new\n',
            sessionId: 'session_new',
        } satisfies SessionNavigationResult);
        const navigationController = createNavigationController(startNewSession);
        const undoRedoController = createUndoRedoController();
        const output = createCapturingOutput();

        await runClearAction(
            output,
            createCodingContext({
                sessionNavigation: navigationController,
                undoRedo: undoRedoController,
            }),
            baseSelection,
            { kind: 'clear' },
        );

        expect(existsSync(oldSessionPath)).toBe(true);
        expect(existsSync(join(tempDir, 'session_old.jsonl'))).toBe(true);
    });
});
