export type PromptArrowDirection = 1 | -1;

const arrowUpSequence = '\u001b[A';
const arrowDownSequence = '\u001b[B';
const csiPrefix = '\u001b[';
const applicationCursorPrefix = '\u001bO';

export function readPromptControlArrowDirection(sequence: string): PromptArrowDirection | undefined {
    const applicationCursorDirection = readApplicationCursorArrowDirection(sequence);
    if (applicationCursorDirection !== undefined) {
        return applicationCursorDirection;
    }
    if (!isCompleteCsiSequence(sequence)) {
        return undefined;
    }
    return readArrowFinalByte(sequence.slice(-1));
}

export function isPendingPromptControlSequence(sequence: string): boolean {
    if (arrowDownSequence.startsWith(sequence) || arrowUpSequence.startsWith(sequence)) {
        return true;
    }
    if (sequence === applicationCursorPrefix) {
        return true;
    }
    if (sequence.startsWith(csiPrefix) && !isCompleteCsiSequence(sequence)) {
        return true;
    }
    return false;
}

export function isCompletePromptControlSequence(sequence: string): boolean {
    if (sequence.startsWith(applicationCursorPrefix) && sequence.length >= applicationCursorPrefix.length + 1) {
        return true;
    }
    return isCompleteCsiSequence(sequence);
}

function readApplicationCursorArrowDirection(sequence: string): PromptArrowDirection | undefined {
    switch (sequence) {
        case '\u001bOB':
            return 1;
        case '\u001bOA':
            return -1;
        default:
            return undefined;
    }
}

function readArrowFinalByte(finalByte: string): PromptArrowDirection | undefined {
    switch (finalByte) {
        case 'B':
            return 1;
        case 'A':
            return -1;
        default:
            return undefined;
    }
}

function isCompleteCsiSequence(sequence: string): boolean {
    if (!sequence.startsWith(csiPrefix) || sequence.length <= csiPrefix.length) {
        return false;
    }
    const finalByte = sequence.charCodeAt(sequence.length - 1);
    return finalByte >= 0x40 && finalByte <= 0x7e;
}
