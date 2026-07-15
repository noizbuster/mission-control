import { describe, expect, it } from 'vitest';
import {
    expandHome,
    extractFilePaths,
    extractPermissionPaths,
    globPrefix,
    isDynamic,
    unquote,
} from './bash-path-extraction';
import { homedir } from 'node:os';

describe('bash path extraction', () => {
    describe('extractFilePaths', () => {
        it('proposes positional paths for a file-mutating command', () => {
            expect(extractFilePaths(['cat', 'foo.txt', 'bar.ts'])).toEqual(['foo.txt', 'bar.ts']);
        });

        it('filters flags and keeps positional paths', () => {
            expect(extractFilePaths(['cp', '-r', '-v', 'src', 'dest'])).toEqual(['src', 'dest']);
        });

        it('filters chmod mode tokens but keeps the target path', () => {
            expect(extractFilePaths(['chmod', '+x', 'script.sh'])).toEqual(['script.sh']);
        });

        it('unquotes quoted path arguments', () => {
            expect(extractFilePaths(['cat', "'my file.txt'", '"other.md"'])).toEqual(['my file.txt', 'other.md']);
        });

        it('expands a leading tilde to the home directory', () => {
            expect(extractFilePaths(['cat', '~/notes.md'])).toEqual([`${homedir()}/notes.md`]);
        });

        it('skips dynamic shell substitutions it cannot resolve', () => {
            expect(extractFilePaths(['cat', '$(echo file)', '${HOME}/x', '$VAR'])).toEqual([]);
        });

        it('reduces a glob argument to its literal prefix', () => {
            expect(extractFilePaths(['cat', 'src/*.ts'])).toEqual(['src/']);
        });

        it('drops a pure-glob argument with no literal prefix', () => {
            expect(extractFilePaths(['cat', '*.ts'])).toEqual([]);
        });

        it('returns nothing for a command whose args are not file paths', () => {
            expect(extractFilePaths(['echo', 'foo.txt', 'bar.ts'])).toEqual([]);
            expect(extractFilePaths(['printf', 'mission-control'])).toEqual([]);
        });

        it('resolves the command token by basename so a qualified path still matches', () => {
            expect(extractFilePaths(['/bin/cat', 'a.txt'])).toEqual(['a.txt']);
        });

        it('returns an empty list for empty argv without throwing', () => {
            expect(extractFilePaths([])).toEqual([]);
        });

        it('returns an empty list when only flags are present', () => {
            expect(extractFilePaths(['rm', '-rf'])).toEqual([]);
        });
    });

    describe('extractPermissionPaths (structured command.run form)', () => {
        it('combines command and args then extracts', () => {
            expect(extractPermissionPaths('cat', ['secret.txt', 'config.yml'])).toEqual(['secret.txt', 'config.yml']);
        });

        it('returns nothing for a non-file command', () => {
            expect(extractPermissionPaths('echo', ['approval-denied'])).toEqual([]);
            expect(extractPermissionPaths('printf', ['mission-control'])).toEqual([]);
        });

        it('returns nothing when given malformed empty input', () => {
            expect(extractPermissionPaths('', [])).toEqual([]);
        });
    });

    describe('helpers', () => {
        it('unquote strips matching surrounding quotes only', () => {
            expect(unquote("'hello'")).toBe('hello');
            expect(unquote('"hello"')).toBe('hello');
            expect(unquote('hello')).toBe('hello');
            expect(unquote("'hello")).toBe("'hello");
            expect(unquote("a'")).toBe("a'");
            expect(unquote('')).toBe('');
        });

        it('expandHome handles ~, ~/, and plain text', () => {
            expect(expandHome('~')).toBe(homedir());
            expect(expandHome('~/x')).toBe(`${homedir()}/x`);
            expect(expandHome('relative/x')).toBe('relative/x');
        });

        it('isDynamic detects substitutions', () => {
            expect(isDynamic('$(whoami)')).toBe(true);
            expect(isDynamic('${HOME}')).toBe(true);
            expect(isDynamic('`cmd`')).toBe(true);
            expect(isDynamic('$VAR')).toBe(true);
            expect(isDynamic('plain.txt')).toBe(false);
        });

        it('globPrefix returns literal prefix or null', () => {
            expect(globPrefix('plain.txt')).toBe('plain.txt');
            expect(globPrefix('src/*.ts')).toBe('src/');
            expect(globPrefix('*.ts')).toBe(null);
            expect(globPrefix('a?b')).toBe('a');
        });
    });
});
