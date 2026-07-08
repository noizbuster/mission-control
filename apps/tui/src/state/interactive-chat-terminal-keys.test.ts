import { describe, expect, it } from 'vitest';
import { isTerminalInterruptToken, readTerminalCursorDirection } from './interactive-chat-terminal-keys.js';

describe('interactive chat terminal keys', () => {
    it('ignores Kitty Ctrl+C release reports without dropping press and repeat interrupts', () => {
        expect(isTerminalInterruptToken('\u001b[99;5u')).toBe(true);
        expect(isTerminalInterruptToken('\u001b[99;5:2u')).toBe(true);
        expect(isTerminalInterruptToken('\u001b[99;5:3u')).toBe(false);
        expect(isTerminalInterruptToken('\u001b[99::99;5:3u')).toBe(false);
    });

    it('reads modern CSI arrow reports and ignores release reports', () => {
        expect(readTerminalCursorDirection('\u001b[1;1B')).toBe('down');
        expect(readTerminalCursorDirection('\u001b[1;1:2B')).toBe('down');
        expect(readTerminalCursorDirection('\u001b[1;1:3B')).toBeUndefined();
        expect(readTerminalCursorDirection('\u001b[1;5:2B')).toBe('input-end');
        expect(readTerminalCursorDirection('\u001b[1;5:3B')).toBeUndefined();
    });
});
