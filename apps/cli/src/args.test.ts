import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
    it('parses all supported mctrl flags', () => {
        expect(parseArgs([])).toEqual({
            mode: 'ink',
            useNative: undefined,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });
        expect(parseArgs(['--ui', 'ink']).mode).toBe('ink');
        expect(parseArgs(['--no-tui']).mode).toBe('plain');
        expect(parseArgs(['--json']).mode).toBe('json');
        expect(parseArgs(['--native']).useNative).toBe(true);
        expect(parseArgs(['--no-native']).useNative).toBe(false);
        expect(parseArgs(['--version']).showVersion).toBe(true);
        expect(parseArgs(['--help']).showHelp).toBe(true);
    });

    it('rejects unsupported arguments', () => {
        expect(() => parseArgs(['--bad-flag'])).toThrow('Unsupported argument: --bad-flag');
    });
});
