import { describe, expect, it } from 'vitest';
import { createTerminalInputParser } from './interactive-chat-terminal-input-parser.js';

describe('terminal input parser', () => {
    it('emits complete UTF-8 graphemes only after bytes are complete', () => {
        const parser = createTerminalInputParser();
        const korean = Buffer.from('\ud55c\uae00', 'utf8');

        expect(parser.readTokens(korean.subarray(0, 1))).toEqual([]);
        expect(parser.readTokens(korean.subarray(1, 2))).toEqual([]);
        expect(parser.readTokens(korean.subarray(2, 3))).toEqual(['\ud55c']);

        expect(parser.readTokens(korean.subarray(3, 4))).toEqual([]);
        expect(parser.readTokens(korean.subarray(4, 5))).toEqual([]);
        expect(parser.readTokens(korean.subarray(5))).toEqual(['\uae00']);
    });

    it('buffers incomplete CSI escape sequences until complete', () => {
        const parser = createTerminalInputParser();

        expect(parser.readTokens('\u001b')).toEqual([]);
        expect(parser.readTokens('[')).toEqual([]);
        expect(parser.readTokens('D')).toEqual(['\u001b[D']);
    });

    it('replays tokens buffered after line submission in FIFO order', () => {
        const parser = createTerminalInputParser();

        parser.pushBufferedTokens(['\u0003', 'x']);
        parser.pushBufferedTokens(['\u001b[D']);

        expect(parser.takeBufferedTokens()).toEqual(['\u0003', 'x', '\u001b[D']);
        expect(parser.takeBufferedTokens()).toEqual([]);
    });
});
