export type TerminalKeyboardMode = {
    readonly modifiedKeysEnabled: boolean;
};

// xterm modifyOtherKeys mode 2 only — intentionally NOT the Kitty keyboard
// protocol. While Kitty keyboard is active, terminals such as WezTerm forward
// terminal-level shortcuts (Ctrl+Shift+C copy, Ctrl+Shift+V paste) into the
// app, where we cannot honour them because we cannot read the X selection.
// modifyOtherKeys 2 still gives us Shift+Enter (`\u001b[27;2;13~`) and
// Ctrl+Arrows (`\u001b[1;5<dir>`), which is all this codebase needs.
export const terminalModifiedKeyEnableSequence = '\u001b[>4;2m';
export const terminalModifiedKeyDisableSequence = '\u001b[>4;0m';

const escapeSequencePrefix = '\u001b[';
const escapeReturnSequence = '\u001b\r';
const csiShiftEnterSequence = `${escapeSequencePrefix}13;2~`;
const modifyOtherKeysShiftEnterSequence = `${escapeSequencePrefix}27;2;13~`;

export function isTerminalShiftEnterSequence(text: string, mode: TerminalKeyboardMode): boolean {
    const sequence = stripTrailingReturn(text);
    return (
        isKittyShiftEnterSequence(sequence) ||
        sequence === csiShiftEnterSequence ||
        sequence === modifyOtherKeysShiftEnterSequence ||
        text === escapeReturnSequence ||
        (mode.modifiedKeysEnabled && text === '\n')
    );
}

function stripTrailingReturn(text: string): string {
    if (text.length > 1 && text.endsWith('\r')) {
        return text.slice(0, -1);
    }
    return text;
}

function isKittyShiftEnterSequence(text: string): boolean {
    if (!text.startsWith(escapeSequencePrefix) || !text.endsWith('u')) {
        return false;
    }
    const payload = text.slice(escapeSequencePrefix.length, -1);
    const parts = payload.split(';');
    const codepoint = parts[0];
    const modifier = parts[1];
    return (codepoint === '13' || codepoint === '57414') && modifier === '2';
}
