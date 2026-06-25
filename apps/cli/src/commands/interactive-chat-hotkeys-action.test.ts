import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import { formatHotkeysText, runHotkeysAction } from './interactive-chat-hotkeys-action.js';
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

describe('formatHotkeysText (registry-driven)', () => {
    const text = formatHotkeysText();

    it('renders the header and registry category groups', () => {
        expect(text).toContain('Keyboard Shortcuts:');
        // Categories are derived from the keybind.ts namespace prefixes.
        expect(text).toContain('Quick Actions:');
        expect(text).toContain('Models:');
        expect(text).toContain('Input Editing:');
    });

    it('includes the documented mctrl quick-action chords from the registry', () => {
        expect(text).toContain('Ctrl+P');
        expect(text).toContain('Ctrl+R');
        expect(text).toContain('Ctrl+T');
        expect(text).toContain('Ctrl+O');
        expect(text).toContain('Ctrl+E');
        expect(text).toContain('Ctrl+V');
        expect(text).toContain('Ctrl+G');
        expect(text).toContain('Ctrl+Z');
    });

    it('includes scrollback and input-editing chords from the registry', () => {
        expect(text).toContain('PgUp');
        expect(text).toContain('PgDn');
        expect(text).toContain('Enter');
        expect(text).toContain('Shift+Enter');
        expect(text).toContain('Backspace');
        expect(text).toContain('Esc');
    });

    it('renders the <leader> token resolved against the leader chord', () => {
        // tips_toggle is `<leader>h` with leader `ctrl+x` -> "Ctrl+X H".
        expect(text).toContain('Ctrl+X H');
    });

    it('aligns the key column by display width (arrow glyphs count as width 1)', () => {
        // Two rows in different categories share one column width so the
        // descriptions line up. Find the model_cycle row and a scrollback row
        // and assert their action columns start at the same offset.
        const lines = text.split('\n');
        const modelLine = lines.find((line) => line.includes('Cycle to next model'));
        const scrollLine = lines.find((line) => line.includes('Scroll messages up by one page'));
        expect(modelLine).toBeDefined();
        expect(scrollLine).toBeDefined();
        const modelActionIndex = modelLine?.indexOf('Cycle to next model') ?? -1;
        const scrollActionIndex = scrollLine?.indexOf('Scroll messages up by one page') ?? -1;
        expect(modelActionIndex).toBe(scrollActionIndex);
    });

    it('ends with a newline so the next prompt starts on a fresh line', () => {
        expect(formatHotkeysText().endsWith('\n')).toBe(true);
    });
});

describe('acceptance (a): a model_cycle override changes the /hotkeys output', () => {
    // misleading_success_output guard: assert the OVERRIDDEN chord lands on the
    // model_cycle row specifically, not merely that "F2" appears somewhere
    // (model_cycle_recent already binds F2 by default).
    it('shows Ctrl+P for model_cycle by default', () => {
        const lines = formatHotkeysText().split('\n');
        const modelCycleLine = lines.find((line) => line.includes('Cycle to next model'));
        expect(modelCycleLine).toContain('Ctrl+P');
    });

    it('shows F2 for model_cycle when overridden to f2', () => {
        const overridden = formatHotkeysText(Keybinds.parse({ model_cycle: 'f2' }));
        const lines = overridden.split('\n');
        const modelCycleLine = lines.find((line) => line.includes('Cycle to next model'));

        expect(modelCycleLine).toContain('F2');
        expect(modelCycleLine).not.toContain('Ctrl+P');
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
