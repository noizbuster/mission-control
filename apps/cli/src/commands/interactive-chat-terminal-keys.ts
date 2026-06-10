import type { TerminalChatCursorDirection } from './interactive-chat-cursor-navigation.js';

export function readTerminalCursorDirection(text: string): TerminalChatCursorDirection | undefined {
    if (matchesTerminalEscapeSequence(text, ctrlLeftSequences)) {
        return 'word-left';
    }
    if (matchesTerminalEscapeSequence(text, ctrlRightSequences)) {
        return 'word-right';
    }
    if (matchesTerminalEscapeSequence(text, ctrlUpSequences)) {
        return 'input-start';
    }
    if (matchesTerminalEscapeSequence(text, ctrlDownSequences)) {
        return 'input-end';
    }
    if (matchesTerminalEscapeSequence(text, homeSequences)) {
        return 'line-start';
    }
    if (matchesTerminalEscapeSequence(text, endSequences)) {
        return 'line-end';
    }
    if (matchesTerminalEscapeSequence(text, pageUpSequences)) {
        return 'input-start';
    }
    if (matchesTerminalEscapeSequence(text, pageDownSequences)) {
        return 'input-end';
    }
    if (text.includes('\u001b[D')) {
        return 'left';
    }
    if (text.includes('\u001b[C')) {
        return 'right';
    }
    if (text.includes('\u001b[A')) {
        return 'up';
    }
    if (text.includes('\u001b[B')) {
        return 'down';
    }
    return undefined;
}

export function isTerminalInterruptToken(token: string): boolean {
    return token === '\u0003' || isKittyCtrlCSequence(token) || isXtermModifiedCtrlCSequence(token);
}

function isKittyCtrlCSequence(token: string): boolean {
    if (!token.startsWith(csiPrefix)) {
        return false;
    }
    const match = /^([0-9]+)(?::[0-9]*)?(?::([0-9]+))?;([0-9]+)(?::[0-9]+)?u$/.exec(token.slice(csiPrefix.length));
    if (match === null) {
        return false;
    }
    const codepoint = Number(match[1]);
    const baseLayoutKey = match[2] === undefined ? undefined : Number(match[2]);
    const modifier = Number(match[3]) - 1;
    return (codepoint === lowercaseCCodepoint || baseLayoutKey === lowercaseCCodepoint) && modifier === ctrlModifier;
}

function isXtermModifiedCtrlCSequence(token: string): boolean {
    if (!token.startsWith(csiPrefix)) {
        return false;
    }
    const match = /^27;([0-9]+);99~$/.exec(token.slice(csiPrefix.length));
    if (match === null) {
        return false;
    }
    return Number(match[1]) - 1 === ctrlModifier;
}

function matchesTerminalEscapeSequence(text: string, sequences: readonly string[]): boolean {
    return sequences.some((sequence) => text.includes(sequence));
}

const ctrlModifier = 4;
const csiPrefix = '\u001b[';
const lowercaseCCodepoint = 99;
const homeSequences = ['\u001b[H', '\u001b[1~', '\u001b[7~', '\u001b[OH', '\u001b[1;1H'] as const;
const endSequences = ['\u001b[F', '\u001b[4~', '\u001b[8~', '\u001b[OF', '\u001b[1;1F'] as const;
const pageUpSequences = ['\u001b[5~'] as const;
const pageDownSequences = ['\u001b[6~'] as const;
const ctrlLeftSequences = ['\u001b[1;5D', '\u001b[5D', '\u001b[27;5;68~'] as const;
const ctrlRightSequences = ['\u001b[1;5C', '\u001b[5C', '\u001b[27;5;67~'] as const;
const ctrlUpSequences = ['\u001b[1;5A', '\u001b[5A', '\u001b[27;5;65~'] as const;
const ctrlDownSequences = ['\u001b[1;5B', '\u001b[5B', '\u001b[27;5;66~'] as const;
