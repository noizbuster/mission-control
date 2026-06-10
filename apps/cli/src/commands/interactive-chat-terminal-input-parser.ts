import { segmentTerminalText } from './terminal-text.js';
import { StringDecoder } from 'node:string_decoder';

const escapeCharacter = '\u001b';

export type TerminalInputParser = {
    readonly readTokens: (chunk: Buffer | string) => readonly string[];
    readonly takeBufferedTokens: () => readonly string[];
    readonly pushBufferedTokens: (tokens: readonly string[]) => void;
};

export function createTerminalInputParser(): TerminalInputParser {
    const decoder = new StringDecoder('utf8');
    let pendingEscape = '';
    const bufferedTokens: string[] = [];

    return {
        readTokens(chunk) {
            const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk);
            if (decoded.length === 0) {
                return [];
            }
            const parsed = extractTerminalInputTokens(`${pendingEscape}${decoded}`);
            pendingEscape = parsed.remainder;
            return parsed.tokens;
        },
        takeBufferedTokens() {
            return bufferedTokens.splice(0, bufferedTokens.length);
        },
        pushBufferedTokens(tokens) {
            bufferedTokens.push(...tokens);
        },
    };
}

function extractTerminalInputTokens(value: string): { readonly tokens: readonly string[]; readonly remainder: string } {
    const tokens: string[] = [];
    let offset = 0;

    while (offset < value.length) {
        const remaining = value.slice(offset);
        if (!remaining.startsWith(escapeCharacter)) {
            const nextEscapeOffset = remaining.indexOf(escapeCharacter);
            const text = nextEscapeOffset === -1 ? remaining : remaining.slice(0, nextEscapeOffset);
            tokens.push(...segmentTerminalText(text).map(({ segment }) => segment));
            offset += text.length;
            continue;
        }

        const sequenceLength = readCompleteEscapeSequenceLength(remaining);
        if (sequenceLength === undefined) {
            return { tokens, remainder: remaining };
        }
        tokens.push(remaining.slice(0, sequenceLength));
        offset += sequenceLength;
    }

    return { tokens, remainder: '' };
}

function readCompleteEscapeSequenceLength(value: string): number | undefined {
    if (value.length === 1) {
        return undefined;
    }
    const introducer = value[1];
    if (introducer === '[') {
        return readCompleteCsiSequenceLength(value);
    }
    if (introducer === 'O') {
        return value.length >= 3 ? 3 : undefined;
    }
    return 2;
}

function readCompleteCsiSequenceLength(value: string): number | undefined {
    if (value.length < 3) {
        return undefined;
    }
    for (let index = 2; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
            return index + 1;
        }
    }
    return undefined;
}
