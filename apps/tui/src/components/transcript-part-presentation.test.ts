import { describe, expect, it } from 'vitest';
import { inferLanguageFromPath, inferToolOutputLanguage } from './transcript-part-presentation';

describe('inferLanguageFromPath', () => {
    it.each([
        ['src/app.ts', 'typescript'],
        ['src/app.tsx', 'tsx'],
        ['index.js', 'javascript'],
        ['config.json', 'json'],
        ['main.py', 'python'],
        ['lib.rs', 'rust'],
        ['main.go', 'go'],
        ['README.md', 'markdown'],
        ['style.css', 'css'],
        ['Dockerfile', 'dockerfile'],
        ['dockerfile', 'dockerfile'],
        ['Makefile', 'makefile'],
        ['build.zsh', 'bash'],
    ])('maps %s to %s', (path, expected) => {
        expect(inferLanguageFromPath(path)).toBe(expected);
    });

    it.each([['noextension'], ['file.'], ['a.b'], ['unknown.xyzq']])('returns undefined for %s', (path) => {
        expect(inferLanguageFromPath(path)).toBeUndefined();
    });
});

describe('inferToolOutputLanguage', () => {
    it('infers language from a file path in the output', () => {
        const output = 'Reading src/app.ts\n1: import { foo } from "bar";';
        expect(inferToolOutputLanguage('repo.read', output)).toBe('typescript');
    });

    it('infers language from a Python file path', () => {
        expect(inferToolOutputLanguage('read', 'main.py: def hello():')).toBe('python');
    });

    it('returns undefined when no file path is found', () => {
        expect(inferToolOutputLanguage('grep', 'no file paths here\njust text')).toBeUndefined();
    });

    it('returns undefined when toolName is undefined', () => {
        expect(inferToolOutputLanguage(undefined, 'src/app.ts content')).toBeUndefined();
    });
});
