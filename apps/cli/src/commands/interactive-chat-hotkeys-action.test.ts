import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import { formatHotkeysText, HOTKEYS_CATEGORIES, runHotkeysAction } from './interactive-chat-hotkeys-action.js';

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

describe('hotkeys command parser', () => {
    it('parses /hotkeys as a hotkeys action', () => {
        expect(parseChatLine('/hotkeys')).toEqual({ kind: 'hotkeys' });
    });

    it('rejects /hotkeys with extra arguments', () => {
        expect(parseChatLine('/hotkeys extra')).toEqual({
            kind: 'invalid',
            message: '/hotkeys does not accept arguments',
        });
    });
});

describe('formatHotkeysText', () => {
    it('contains every category header', () => {
        const text = formatHotkeysText();

        expect(text).toContain('Input Editing:');
        expect(text).toContain('Cursor Navigation:');
        expect(text).toContain('Scrollback:');
        expect(text).toContain('Clipboard:');
        expect(text).toContain('Quick Actions:');
        expect(text).toContain('Modes:');
    });

    it('includes Ctrl+P for model cycling', () => {
        expect(formatHotkeysText()).toContain('Ctrl+P');
    });

    it('includes Ctrl+R for the rename overlay', () => {
        expect(formatHotkeysText()).toContain('Ctrl+R');
    });

    it('includes Shift+Enter for multi-line input', () => {
        expect(formatHotkeysText()).toContain('Shift+Enter');
    });

    it('includes Ctrl+E for the external editor', () => {
        expect(formatHotkeysText()).toContain('Ctrl+E');
    });

    it('includes wave-5 shortcuts (scrollback, clipboard, double-esc)', () => {
        const text = formatHotkeysText();

        expect(text).toContain('Ctrl+V');
        expect(text).toContain('PgUp');
        expect(text).toContain('PgDn');
        expect(text).toContain('Home');
        expect(text).toContain('End');
        expect(text).toContain('Esc Esc');
    });

    it('ends with a newline so the next prompt starts on a fresh line', () => {
        expect(formatHotkeysText().endsWith('\n')).toBe(true);
    });
});

describe('HOTKEYS_CATEGORIES', () => {
    it('lists every implemented shortcut key', () => {
        const keys = HOTKEYS_CATEGORIES.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.key));

        expect(keys).toContain('Enter');
        expect(keys).toContain('Shift+Enter');
        expect(keys).toContain('Backspace');
        expect(keys).toContain('Ctrl+D');
        expect(keys).toContain('Ctrl+\u2190');
        expect(keys).toContain('Ctrl+\u2192');
        expect(keys).toContain('\u2191/\u2193');
        expect(keys).toContain('Ctrl+C');
        expect(keys).toContain('Ctrl+Z');
        expect(keys).toContain('Ctrl+P');
        expect(keys).toContain('Shift+Ctrl+P');
        expect(keys).toContain('Ctrl+T');
        expect(keys).toContain('Ctrl+O');
        expect(keys).toContain('Ctrl+E');
        expect(keys).toContain('Ctrl+R');
        expect(keys).toContain('Ctrl+V');
        expect(keys).toContain('PgUp');
        expect(keys).toContain('PgDn');
        expect(keys).toContain('Home');
        expect(keys).toContain('End');
        expect(keys).toContain('Esc Esc');
        expect(keys).toContain('/model');
    });
});

describe('runHotkeysAction', () => {
    it('writes formatted hotkeys text to chatOutput', async () => {
        const output = createCapturingOutput();

        await runHotkeysAction(output, { providerID: 'local', modelID: 'local-echo' }, undefined);

        const text = output.text();
        expect(text).toContain('Keyboard Shortcuts:');
        expect(text).toContain('Quick Actions:');
        expect(text).toContain('Ctrl+P');
    });

    it('returns a ChatActionResult preserving the model provider selection', async () => {
        const output = createCapturingOutput();
        const selection = { providerID: 'local', modelID: 'local-echo' };

        const result = await runHotkeysAction(output, selection, undefined);

        expect(result.modelProviderSelection).toEqual(selection);
    });
});
