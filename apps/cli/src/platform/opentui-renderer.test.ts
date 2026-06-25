import { describe, expect, it } from 'vitest';
import { type InkStyleInput, toOpenTuiAttributes, toOpenTuiBorderStyle, toOpenTuiColor } from './opentui-types.js';

describe('opentui-types', () => {
    describe('toOpenTuiColor', () => {
        it('maps named Ink colors to hex', () => {
            expect(toOpenTuiColor('red')).toBe('#ff0000');
            expect(toOpenTuiColor('green')).toBe('#00ff00');
            expect(toOpenTuiColor('cyan')).toBe('#00ffff');
            expect(toOpenTuiColor('blue')).toBe('#0000ff');
            expect(toOpenTuiColor('magenta')).toBe('#ff00ff');
            expect(toOpenTuiColor('yellow')).toBe('#ffff00');
        });

        it('maps bright variants', () => {
            expect(toOpenTuiColor('redBright')).toBe('#ff5555');
            expect(toOpenTuiColor('greenBright')).toBe('#55ff55');
            expect(toOpenTuiColor('cyanBright')).toBe('#55ffff');
        });

        it('maps gray/grey aliases to the same hex', () => {
            expect(toOpenTuiColor('gray')).toBe('#808080');
            expect(toOpenTuiColor('grey')).toBe('#808080');
        });

        it('passes through hex colors unchanged', () => {
            expect(toOpenTuiColor('#aabbcc')).toBe('#aabbcc');
            expect(toOpenTuiColor('#000000')).toBe('#000000');
        });

        it('returns undefined for undefined input', () => {
            expect(toOpenTuiColor(undefined)).toBeUndefined();
        });

        it('passes through unknown named colors', () => {
            expect(toOpenTuiColor('unknownColor')).toBe('unknownColor');
        });
    });

    describe('toOpenTuiBorderStyle', () => {
        it('maps round to rounded', () => {
            expect(toOpenTuiBorderStyle('round')).toBe('rounded');
        });

        it('maps rounded to rounded', () => {
            expect(toOpenTuiBorderStyle('rounded')).toBe('rounded');
        });

        it('passes through single', () => {
            expect(toOpenTuiBorderStyle('single')).toBe('single');
        });

        it('passes through double', () => {
            expect(toOpenTuiBorderStyle('double')).toBe('double');
        });

        it('passes through bold', () => {
            expect(toOpenTuiBorderStyle('bold')).toBe('bold');
        });

        it('returns undefined for undefined input', () => {
            expect(toOpenTuiBorderStyle(undefined)).toBeUndefined();
        });

        it('passes through unknown styles', () => {
            expect(toOpenTuiBorderStyle('dashed')).toBe('dashed');
        });
    });

    describe('toOpenTuiAttributes', () => {
        it('maps bold', () => {
            const input: InkStyleInput = { bold: true };
            expect(toOpenTuiAttributes(input)).toEqual({ bold: true });
        });

        it('maps dimColor to dim', () => {
            const input: InkStyleInput = { dimColor: true };
            expect(toOpenTuiAttributes(input)).toEqual({ dim: true });
        });

        it('maps multiple attributes', () => {
            const input: InkStyleInput = { bold: true, dimColor: true };
            expect(toOpenTuiAttributes(input)).toEqual({ bold: true, dim: true });
        });

        it('maps all supported attributes', () => {
            const input: InkStyleInput = {
                bold: true,
                italic: true,
                dimColor: true,
                underline: true,
                strikethrough: true,
                inverse: true,
            };
            expect(toOpenTuiAttributes(input)).toEqual({
                bold: true,
                italic: true,
                dim: true,
                underline: true,
                strikethrough: true,
                inverse: true,
            });
        });

        it('returns empty object for no attributes', () => {
            const input: InkStyleInput = {};
            expect(toOpenTuiAttributes(input)).toEqual({});
        });

        it('omits falsy flags', () => {
            const input: InkStyleInput = { bold: false, italic: true };
            expect(toOpenTuiAttributes(input)).toEqual({ italic: true });
        });
    });
});
