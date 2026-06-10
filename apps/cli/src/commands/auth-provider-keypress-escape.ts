export type PromptArrowDirection = 1 | -1;
export type PromptArrowEventType = 'press' | 'repeat';
export type PromptArrowKeypress = {
    readonly direction: PromptArrowDirection;
    readonly eventType: PromptArrowEventType;
    readonly modifier: number;
    readonly sequence: string;
};

type CsiArrowKeyFields = {
    readonly eventType: PromptArrowEventType | 'release';
    readonly modifier: number;
};

const arrowUpSequence = '\u001b[A';
const arrowDownSequence = '\u001b[B';
const csiPrefix = '\u001b[';
const applicationCursorPrefix = '\u001bO';

export function readPromptControlArrowDirection(sequence: string): PromptArrowDirection | undefined {
    return readPromptControlArrowKeypress(sequence)?.direction;
}

export function readPromptControlArrowKeypress(sequence: string): PromptArrowKeypress | undefined {
    const applicationCursorDirection = readApplicationCursorArrowDirection(sequence);
    if (applicationCursorDirection !== undefined) {
        return { direction: applicationCursorDirection, eventType: 'press', modifier: 1, sequence };
    }
    if (!isCompleteCsiSequence(sequence)) {
        return undefined;
    }
    const direction = readArrowFinalByte(sequence.slice(-1));
    if (direction === undefined) {
        return undefined;
    }
    const fields = readCsiArrowKeyFields(sequence);
    if (fields === undefined || fields.eventType === 'release') {
        return undefined;
    }
    return { direction, eventType: fields.eventType, modifier: fields.modifier, sequence };
}

export function areEquivalentPromptArrowKeypresses(previous: PromptArrowKeypress, next: PromptArrowKeypress): boolean {
    return (
        previous.direction === next.direction &&
        previous.eventType === 'press' &&
        next.eventType === 'press' &&
        previous.modifier === 1 &&
        next.modifier === 1 &&
        previous.sequence !== next.sequence
    );
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

function readCsiArrowKeyFields(sequence: string): CsiArrowKeyFields | undefined {
    const parameters = sequence.slice(csiPrefix.length, -1);
    if (parameters.length === 0) {
        return { eventType: 'press', modifier: 1 };
    }
    const parts = parameters.split(';');
    if (parts.length > 2) {
        return undefined;
    }
    return readCsiArrowModifierField(parts.length === 2 ? parts[1] : parts[0]);
}

function readCsiArrowModifierField(field: string | undefined): CsiArrowKeyFields | undefined {
    if (field === undefined) {
        return undefined;
    }
    const parts = field.split(':');
    if (parts.length > 2) {
        return undefined;
    }
    const modifier = readDecimalInteger(parts[0]);
    const eventType = readCsiArrowEventType(parts[1]);
    if (modifier === undefined || modifier <= 0 || eventType === undefined) {
        return undefined;
    }
    return {
        eventType,
        modifier,
    };
}

function readCsiArrowEventType(value: string | undefined): PromptArrowEventType | 'release' | undefined {
    switch (value) {
        case undefined:
        case '':
        case '1':
            return 'press';
        case '2':
            return 'repeat';
        case '3':
            return 'release';
        default:
            return undefined;
    }
}

function readDecimalInteger(value: string | undefined): number | undefined {
    if (value === undefined || !/^[0-9]+$/.test(value)) {
        return undefined;
    }
    return Number(value);
}

function isCompleteCsiSequence(sequence: string): boolean {
    if (!sequence.startsWith(csiPrefix) || sequence.length <= csiPrefix.length) {
        return false;
    }
    const finalByte = sequence.charCodeAt(sequence.length - 1);
    return finalByte >= 0x40 && finalByte <= 0x7e;
}
