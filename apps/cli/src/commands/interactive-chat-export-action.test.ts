import { describe, expect, it, vi } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    resolveSlashCommandMenuSubmission,
} from './interactive-chat-command-menu.js';
import { runExportAction } from './interactive-chat-export-action.js';
import { exportSessionArchiveFile } from './session-archive.js';

vi.mock('./session-archive.js', () => ({
    exportSessionArchiveFile: vi.fn(),
}));

const mockedExport = vi.mocked(exportSessionArchiveFile);

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

function createCodingContext(sessionId: string | undefined): {
    readonly provider: undefined;
    readonly sessionId: string | undefined;
    readonly workspaceRoot: undefined;
    readonly commandExecutor: undefined;
    readonly emitEvent: undefined;
    readonly observeStoredEvent: undefined;
    readonly nextTurnId: () => string;
    readonly sessionStore: undefined;
    readonly activeTurn: undefined;
} {
    return {
        provider: undefined,
        sessionId,
        workspaceRoot: undefined,
        commandExecutor: undefined,
        emitEvent: undefined,
        observeStoredEvent: undefined,
        nextTurnId: () => 'turn_export_test',
        sessionStore: undefined,
        activeTurn: undefined,
    };
}

describe('export command parser', () => {
    it('resolves a default session-<id>.html path when no path is supplied', () => {
        expect(parseChatLine('/export', { currentSessionId: 'session_abc' })).toEqual({
            kind: 'export',
            path: 'session-session_abc.html',
        });
    });

    it('preserves an explicit json path argument', () => {
        expect(parseChatLine('/export /tmp/my.json')).toEqual({
            kind: 'export',
            path: '/tmp/my.json',
        });
    });

    it('preserves an explicit html path argument', () => {
        expect(parseChatLine('/export /tmp/my.html')).toEqual({
            kind: 'export',
            path: '/tmp/my.html',
        });
    });

    it('rejects more than one path argument', () => {
        expect(parseChatLine('/export /tmp/a.json extra')).toEqual({
            kind: 'invalid',
            message: '/export accepts at most one file path',
        });
    });

    it('rejects a bare /export when there is no active session', () => {
        expect(parseChatLine('/export')).toEqual({
            kind: 'invalid',
            message: '/export requires a file path or an active session',
        });
    });
});

describe('export slash command menu', () => {
    it('filters /exp down to the /export command', () => {
        const state = createSlashCommandMenuState();
        const view = createSlashCommandMenuView('/exp', state, 20);

        expect(view.open).toBe(true);
        expect(view.totalCount).toBe(1);
        expect(view.visibleChoices.map((choice) => choice.id)).toEqual(['/export']);
    });

    it('resolves a partial /exp submission to /export', () => {
        const state = createSlashCommandMenuState();
        expect(resolveSlashCommandMenuSubmission('/exp', state)).toBe('/export');
    });
});

describe('export action handler', () => {
    it('calls the existing export function with the session id and resolved path', async () => {
        mockedExport.mockReset();
        mockedExport.mockResolvedValue('Exported session session_abc to session-session_abc.html\n');

        const output = createCapturingOutput();
        await runExportAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            createCodingContext('session_abc'),
            { kind: 'export', path: 'session-session_abc.html' },
        );

        expect(mockedExport).toHaveBeenCalledWith({
            sessionId: 'session_abc',
            filePath: 'session-session_abc.html',
        });
        expect(output.text()).toContain('Exported session session_abc');
    });

    it('writes an error and skips export when no session is active', async () => {
        mockedExport.mockReset();

        const output = createCapturingOutput();
        await runExportAction(output, { providerID: 'local', modelID: 'local-echo' }, createCodingContext(undefined), {
            kind: 'export',
            path: '/tmp/anywhere.html',
        });

        expect(mockedExport).not.toHaveBeenCalled();
        expect(output.text()).toContain('Error:');
    });

    it('surfaces export failures as error output', async () => {
        mockedExport.mockReset();
        mockedExport.mockRejectedValue(new Error('session log not found'));

        const output = createCapturingOutput();
        await runExportAction(
            output,
            { providerID: 'local', modelID: 'local-echo' },
            createCodingContext('session_missing'),
            { kind: 'export', path: '/tmp/missing.html' },
        );

        expect(mockedExport).toHaveBeenCalledWith({
            sessionId: 'session_missing',
            filePath: '/tmp/missing.html',
        });
        expect(output.text()).toContain('Error: session log not found');
    });
});
