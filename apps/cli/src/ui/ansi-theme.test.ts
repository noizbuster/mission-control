import { describe, expect, it } from 'vitest';
import type { TerminalTextStyle } from '../components/markdown/theme.js';
import {
    RESET,
    TEXT_DANGER,
    TEXT_DANGER_BOLD,
    TEXT_DIM,
    TEXT_DIM_BOLD,
    TEXT_HIGHLIGHT,
    TEXT_HIGHLIGHT_BOLD,
    TEXT_INFO,
    TEXT_INFO_BOLD,
    TEXT_NORMAL,
    TEXT_NORMAL_BOLD,
    TEXT_SUCCESS,
    TEXT_SUCCESS_BOLD,
    TEXT_WARNING,
    TEXT_WARNING_BOLD,
    sgr,
    terminalTextStyleToAnsi,
    wrap,
} from './ansi-theme.js';

describe('ansi-theme SGR constants (mirror opencode UI.Style)', () => {
    it('TEXT_HIGHLIGHT is bright cyan', () => {
        expect(TEXT_HIGHLIGHT).toBe('\x1b[96m');
    });

    it('TEXT_HIGHLIGHT_BOLD is bright cyan then bold', () => {
        expect(TEXT_HIGHLIGHT_BOLD).toBe('\x1b[96m\x1b[1m');
    });

    it('TEXT_DIM is bright black', () => {
        expect(TEXT_DIM).toBe('\x1b[90m');
    });

    it('TEXT_DIM_BOLD is bright black then bold', () => {
        expect(TEXT_DIM_BOLD).toBe('\x1b[90m\x1b[1m');
    });

    it('TEXT_NORMAL is reset', () => {
        expect(TEXT_NORMAL).toBe('\x1b[0m');
    });

    it('TEXT_NORMAL_BOLD is bold only', () => {
        expect(TEXT_NORMAL_BOLD).toBe('\x1b[1m');
    });

    it('TEXT_WARNING is yellow', () => {
        expect(TEXT_WARNING).toBe('\x1b[93m');
    });

    it('TEXT_WARNING_BOLD is yellow then bold', () => {
        expect(TEXT_WARNING_BOLD).toBe('\x1b[93m\x1b[1m');
    });

    it('TEXT_DANGER is bright red', () => {
        expect(TEXT_DANGER).toBe('\x1b[91m');
    });

    it('TEXT_DANGER_BOLD is bright red then bold', () => {
        expect(TEXT_DANGER_BOLD).toBe('\x1b[91m\x1b[1m');
    });

    it('TEXT_SUCCESS is bright green', () => {
        expect(TEXT_SUCCESS).toBe('\x1b[92m');
    });

    it('TEXT_SUCCESS_BOLD is bright green then bold', () => {
        expect(TEXT_SUCCESS_BOLD).toBe('\x1b[92m\x1b[1m');
    });

    it('TEXT_INFO is bright blue', () => {
        expect(TEXT_INFO).toBe('\x1b[94m');
    });

    it('TEXT_INFO_BOLD is bright blue then bold', () => {
        expect(TEXT_INFO_BOLD).toBe('\x1b[94m\x1b[1m');
    });

    it('RESET aliases TEXT_NORMAL', () => {
        expect(RESET).toBe('\x1b[0m');
        expect(RESET).toBe(TEXT_NORMAL);
    });
});

describe('sgr(code)', () => {
    it('wraps a numeric code into a CSI SGR sequence', () => {
        expect(sgr(0)).toBe('\x1b[0m');
        expect(sgr(1)).toBe('\x1b[1m');
        expect(sgr(96)).toBe('\x1b[96m');
    });
});

describe('wrap(text, open)', () => {
    it('appends RESET after the open sequence and text', () => {
        expect(wrap('x', '\x1b[1m')).toBe('\x1b[1mx\x1b[0m');
    });

    it('returns plain text when open is empty', () => {
        expect(wrap('hello', '')).toBe('hello');
    });

    it('round-trips a styled segment built from terminalTextStyleToAnsi', () => {
        const open = terminalTextStyleToAnsi({ bold: true }, true);
        const wrapped = wrap('x', open);
        expect(wrapped.startsWith('\x1b[1m')).toBe(true);
        expect(wrapped.endsWith('x\x1b[0m')).toBe(true);
    });
});

describe('terminalTextStyleToAnsi', () => {
    it('emits a bold escape when colorize is true and bold is set', () => {
        const open = terminalTextStyleToAnsi({ bold: true }, true);
        expect(open.startsWith('\x1b[1m')).toBe(true);
        expect(open).toBe('\x1b[1m');
    });

    it('returns empty string when colorize is false even if style is non-empty', () => {
        const style: TerminalTextStyle = { bold: true, fg: '#00ffff' };
        expect(terminalTextStyleToAnsi(style, false)).toBe('');
    });

    it('returns empty string when style has no effective flags', () => {
        expect(terminalTextStyleToAnsi({}, true)).toBe('');
    });

    it('returns empty string when every flag is explicitly false / undefined', () => {
        const style: TerminalTextStyle = {
            bold: false,
            dim: false,
            italic: false,
            inverse: false,
            underline: false,
            strikethrough: false,
        };
        expect(terminalTextStyleToAnsi(style, true)).toBe('');
    });

    it('emits each boolean attribute escape independently', () => {
        expect(terminalTextStyleToAnsi({ dim: true }, true)).toBe('\x1b[2m');
        expect(terminalTextStyleToAnsi({ italic: true }, true)).toBe('\x1b[3m');
        expect(terminalTextStyleToAnsi({ underline: true }, true)).toBe('\x1b[4m');
        expect(terminalTextStyleToAnsi({ strikethrough: true }, true)).toBe('\x1b[9m');
        expect(terminalTextStyleToAnsi({ inverse: true }, true)).toBe('\x1b[7m');
    });

    it('concatenates boolean flags in the documented order then fg then bg', () => {
        const style: TerminalTextStyle = {
            bold: true,
            dim: true,
            italic: true,
            underline: true,
            strikethrough: true,
            inverse: true,
            fg: '#000001',
            bg: '#000002',
        };
        expect(terminalTextStyleToAnsi(style, true)).toBe(
            '\x1b[1m\x1b[2m\x1b[3m\x1b[4m\x1b[9m\x1b[7m\x1b[38;2;0;0;1m\x1b[48;2;0;0;2m',
        );
    });

    it('converts an fg hex to a truecolor foreground escape', () => {
        expect(terminalTextStyleToAnsi({ fg: '#00ffff' }, true)).toBe('\x1b[38;2;0;255;255m');
    });

    it('converts a bg hex to a truecolor background escape', () => {
        expect(terminalTextStyleToAnsi({ bg: '#808080' }, true)).toBe('\x1b[48;2;128;128;128m');
    });

    it('combines bold + fg hex (darkTheme.heading parity)', () => {
        expect(terminalTextStyleToAnsi({ bold: true, fg: '#00ffff' }, true)).toBe(
            '\x1b[1m\x1b[38;2;0;255;255m',
        );
    });

    it('does not throw on malformed hex and emits no fg segment', () => {
        // Malformed: non-hex chars. Must not throw; the fg segment is dropped,
        // but a sibling boolean flag still emits its own escape.
        const onlyBadFg = terminalTextStyleToAnsi({ fg: '#zzzzzz' }, true);
        expect(onlyBadFg).toBe('');
        const badFgWithBold = terminalTextStyleToAnsi({ bold: true, fg: '#zzzzzz' }, true);
        expect(badFgWithBold).toBe('\x1b[1m');
    });

    it('rejects 3-digit short hex (#fff) and emits no fg segment', () => {
        expect(terminalTextStyleToAnsi({ fg: '#fff' }, true)).toBe('');
    });

    it('rejects a missing hash and emits no fg segment', () => {
        expect(terminalTextStyleToAnsi({ fg: '00ffff' }, true)).toBe('');
    });

    it('handles uppercase hex digits', () => {
        expect(terminalTextStyleToAnsi({ fg: '#00FFFF' }, true)).toBe('\x1b[38;2;0;255;255m');
    });

    it('does not emit bg when only fg is set, and vice versa', () => {
        expect(terminalTextStyleToAnsi({ fg: '#00ffff' }, true)).not.toContain('48;2');
        expect(terminalTextStyleToAnsi({ bg: '#00ffff' }, true)).not.toContain('38;2');
    });

    it('strips a noColorTheme-style non-empty style when colorize is false', () => {
        // noColorTheme.heading is { bold: true } - the colorize gate must drop it.
        expect(terminalTextStyleToAnsi({ bold: true }, false)).toBe('');
        expect(terminalTextStyleToAnsi({ inverse: true }, false)).toBe('');
    });
});
