import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import { formatHelpText, runHelpAction } from './interactive-chat-help-action.js';
import { Keybinds } from '../platform/keymap/keybind.js';

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

describe('help command parser', () => {
    it('parses /help as a help action', () => {
        expect(parseChatLine('/help')).toEqual({ kind: 'help' });
    });

    it('rejects /help with extra arguments', () => {
        expect(parseChatLine('/help extra')).toEqual({
            kind: 'invalid',
            message: '/help does not accept arguments',
        });
    });
});

describe('formatHelpText', () => {
    it('produces output containing Commands and Keyboard Shortcuts sections', () => {
        const text = formatHelpText([{ id: '/test', description: 'A test command' }]);

        expect(text).toContain('Commands:');
        expect(text).toContain('Keyboard Shortcuts:');
    });

    it('includes all command IDs from the input', () => {
        const commands = [
            { id: '/alpha', description: 'First command' },
            { id: '/beta', description: 'Second command' },
            { id: '/gamma', description: 'Third command' },
        ];

        const text = formatHelpText(commands);

        expect(text).toContain('/alpha');
        expect(text).toContain('/beta');
        expect(text).toContain('/gamma');
    });

    it('aligns command descriptions in columns by display width', () => {
        const commands = [
            { id: '/x', description: 'Short id' },
            { id: '/long-command', description: 'Long id' },
        ];

        const text = formatHelpText(commands);
        const lines = text.split('\n');
        const shortLine = lines.find((line) => line.includes('/x') && line.includes('Short id'));
        const longLine = lines.find((line) => line.includes('/long-command') && line.includes('Long id'));

        expect(shortLine).toBeDefined();
        expect(longLine).toBeDefined();
        const shortDescriptionIndex = shortLine?.indexOf('Short id') ?? -1;
        const longDescriptionIndex = longLine?.indexOf('Long id') ?? -1;

        expect(shortDescriptionIndex).toBe(longDescriptionIndex);
    });

    it('renders the keyboard section from the keybind registry', () => {
        const text = formatHelpText([{ id: '/test', description: 'Test' }]);

        // Registry-sourced chords (same source as /hotkeys).
        expect(text).toContain('Ctrl+P');
        expect(text).toContain('Ctrl+R');
        expect(text).toContain('Enter');
        expect(text).toContain('PgUp');
    });

    it('ends with a newline so the next prompt starts on a fresh line', () => {
        const text = formatHelpText([{ id: '/test', description: 'Test' }]);

        expect(text.endsWith('\n')).toBe(true);
    });
});

describe('formatHelpText keyboard section reflects keybind overrides', () => {
    it('shows F2 for model_cycle when overridden', () => {
        const text = formatHelpText([], Keybinds.parse({ model_cycle: 'f2' }));
        const lines = text.split('\n');
        const modelCycleLine = lines.find((line) => line.includes('Cycle to next model'));

        expect(modelCycleLine).toContain('F2');
        expect(modelCycleLine).not.toContain('Ctrl+P');
    });
});

describe('runHelpAction', () => {
    it('writes formatted help text to chatOutput', async () => {
        const output = createCapturingOutput();

        await runHelpAction(
            output,
            [{ id: '/demo', description: 'Demo command' }],
            { providerID: 'local', modelID: 'local-echo' },
            undefined,
        );

        const text = output.text();
        expect(text).toContain('Commands:');
        expect(text).toContain('Keyboard Shortcuts:');
        expect(text).toContain('/demo');
        expect(text).toContain('Demo command');
    });

    it('returns a ChatActionResult preserving the model provider selection', async () => {
        const output = createCapturingOutput();
        const selection = { providerID: 'local', modelID: 'local-echo' };

        const result = await runHelpAction(output, [], selection, undefined);

        expect(result.modelProviderSelection).toEqual(selection);
    });
});
