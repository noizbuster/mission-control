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
    const arrowKeypress = readTerminalArrowKeypress(text);
    if (arrowKeypress !== undefined) {
        return mapTerminalArrowKeypressToCursorDirection(arrowKeypress);
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

export function interruptTokenEncodingFamily(token: string): string {
    if (token === '\u0003') {
        return 'legacy';
    }
    if (isKittyCtrlCSequence(token)) {
        return 'kitty';
    }
    if (isXtermModifiedCtrlCSequence(token)) {
        return 'xterm';
    }
    return token;
}

function isKittyCtrlCSequence(token: string): boolean {
    if (!token.startsWith(csiPrefix) || !token.endsWith('u')) {
        return false;
    }
    const fields = token.slice(csiPrefix.length, -1).split(';');
    if (fields.length !== 2) {
        return false;
    }
    const keyReport = readKittyKeyReport(fields[0]);
    const modifierReport = readKittyModifierReport(fields[1]);
    if (keyReport === undefined || modifierReport === undefined || modifierReport.eventType === 'release') {
        return false;
    }
    return (
        (keyReport.codepoint === lowercaseCCodepoint || keyReport.baseLayoutKey === lowercaseCCodepoint) &&
        modifierReport.modifier === ctrlModifier
    );
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

type TerminalArrowDirection = 'up' | 'down' | 'left' | 'right';

type TerminalKeyEventType = 'press' | 'repeat' | 'release';

type TerminalArrowKeypress = {
    readonly direction: TerminalArrowDirection;
    readonly modifier: number;
};

type TerminalKeyModifierReport = {
    readonly modifier: number;
    readonly eventType: TerminalKeyEventType;
};

type KittyKeyReport = {
    readonly codepoint: number;
    readonly baseLayoutKey: number | undefined;
};

function readTerminalArrowKeypress(sequence: string): TerminalArrowKeypress | undefined {
    const finalByte = sequence.at(-1);
    const direction = finalByte === undefined ? undefined : readTerminalArrowDirection(finalByte);
    if (direction === undefined) {
        return undefined;
    }
    if (sequence.startsWith(applicationCursorPrefix) && sequence.length === applicationCursorPrefix.length + 1) {
        return { direction, modifier: 0 };
    }
    if (!sequence.startsWith(csiPrefix)) {
        return undefined;
    }
    const modifierReport = readCsiArrowModifierReport(sequence.slice(csiPrefix.length, -1));
    if (modifierReport === undefined || modifierReport.eventType === 'release') {
        return undefined;
    }
    return { direction, modifier: modifierReport.modifier };
}

function readTerminalArrowDirection(finalByte: string): TerminalArrowDirection | undefined {
    switch (finalByte) {
        case 'A':
            return 'up';
        case 'B':
            return 'down';
        case 'C':
            return 'right';
        case 'D':
            return 'left';
        default:
            return undefined;
    }
}

function readCsiArrowModifierReport(payload: string): TerminalKeyModifierReport | undefined {
    if (payload.length === 0) {
        return { modifier: 0, eventType: 'press' };
    }
    const fields = payload.split(';');
    if (fields.length === 1) {
        return readTerminalKeyModifierReport(fields[0]);
    }
    if (fields.length !== 2) {
        return undefined;
    }
    return readTerminalKeyModifierReport(fields[1]);
}

function readTerminalKeyModifierReport(field: string | undefined): TerminalKeyModifierReport | undefined {
    if (field === undefined) {
        return undefined;
    }
    const parts = field.split(':');
    if (parts.length > 2) {
        return undefined;
    }
    const encodedModifier = readDecimalInteger(parts[0]);
    const eventType = readTerminalKeyEventType(parts[1]);
    if (encodedModifier === undefined || encodedModifier <= 0 || eventType === undefined) {
        return undefined;
    }
    return { modifier: encodedModifier - 1, eventType };
}

function readTerminalKeyEventType(field: string | undefined): TerminalKeyEventType | undefined {
    if (field === undefined || field.length === 0) {
        return 'press';
    }
    const eventType = readDecimalInteger(field);
    switch (eventType) {
        case 1:
            return 'press';
        case 2:
            return 'repeat';
        case 3:
            return 'release';
        default:
            return undefined;
    }
}

function mapTerminalArrowKeypressToCursorDirection(keypress: TerminalArrowKeypress): TerminalChatCursorDirection {
    if (keypress.modifier === ctrlModifier) {
        switch (keypress.direction) {
            case 'left':
                return 'word-left';
            case 'right':
                return 'word-right';
            case 'up':
                return 'input-start';
            case 'down':
                return 'input-end';
        }
    }
    return keypress.direction;
}

function readKittyKeyReport(field: string | undefined): KittyKeyReport | undefined {
    if (field === undefined) {
        return undefined;
    }
    const parts = field.split(':');
    if (parts.length > 3) {
        return undefined;
    }
    const codepoint = readDecimalInteger(parts[0]);
    if (codepoint === undefined) {
        return undefined;
    }
    return { codepoint, baseLayoutKey: readDecimalInteger(parts[2]) };
}

function readKittyModifierReport(field: string | undefined): TerminalKeyModifierReport | undefined {
    return readTerminalKeyModifierReport(field);
}

function readDecimalInteger(value: string | undefined): number | undefined {
    if (value === undefined || !/^[0-9]+$/.test(value)) {
        return undefined;
    }
    return Number(value);
}

const ctrlModifier = 4;
const applicationCursorPrefix = '\u001bO';
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
