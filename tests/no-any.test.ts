import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sourceRoots = ['packages', 'apps', 'scripts', 'tests'] as const;
const directivePattern = /@ts-ignore|@ts-expect-error/;

function collectFiles(dir: string): string[] {
    const absoluteDir = join(root, dir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'target') {
            continue;
        }
        const path = join(absoluteDir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            files.push(...collectFiles(path.slice(root.length + 1)));
            continue;
        }
        if (path.endsWith('.ts') || path.endsWith('.tsx')) {
            files.push(path);
        }
    }
    return files;
}

function languageVariantFor(file: string): LanguageVariant {
    return file.endsWith('.tsx') ? LanguageVariant.JSX : LanguageVariant.Standard;
}

function locationFor(sourceText: string, position: number): string {
    const lines = sourceText.slice(0, position).split('\n');
    const lastLine = lines.at(-1) ?? '';
    return `${lines.length}:${lastLine.length + 1}`;
}

function maskComments(sourceText: string, addDirective: (position: number, label: string) => void): string {
    const chars = sourceText.split('');
    const maskRange = (start: number, end: number): void => {
        for (let index = start; index < end; index++) {
            if (chars[index] !== '\n') chars[index] = ' ';
        }
    };
    const collectDirective = (start: number, end: number): void => {
        const match = directivePattern.exec(sourceText.slice(start, end));
        if (match !== null) addDirective(start, match[0]);
    };

    for (let index = 0; index < sourceText.length; index++) {
        const char = sourceText[index];
        if (char === "'" || char === '"' || char === '`') {
            const quote = char;
            index++;
            while (index < sourceText.length) {
                if (sourceText[index] === '\\') {
                    index++;
                } else if (sourceText[index] === quote) {
                    break;
                }
                index++;
            }
            continue;
        }
        if (char !== '/') continue;
        if (sourceText[index + 1] === '/') {
            const end = sourceText.indexOf('\n', index + 2);
            const commentEnd = end === -1 ? sourceText.length : end;
            collectDirective(index, commentEnd);
            maskRange(index, commentEnd);
            index = commentEnd;
        } else if (sourceText[index + 1] === '*') {
            const end = sourceText.indexOf('*/', index + 2);
            const commentEnd = end === -1 ? sourceText.length : end + 2;
            collectDirective(index, commentEnd);
            maskRange(index, commentEnd);
            index = commentEnd - 1;
        }
    }

    return chars.join('');
}

function findEscapeHatches(file: string, sourceText: string): string[] {
    const hatches: string[] = [];
    const addHatch = (position: number, label: string): void => {
        hatches.push(`${locationFor(sourceText, position)} ${label}`);
    };
    const maskedText = maskComments(sourceText, addHatch);
    const scanner = createScanner(true, languageVariantFor(file), maskedText);
    let previousToken: SyntaxKind | undefined;
    let previousEnd = -1;

    while (true) {
        const token = scanner.scan();
        if (token === SyntaxKind.EndOfFile) break;

        const tokenStart = scanner.getTokenStart();
        const tokenEnd = scanner.getTokenEnd();
        if (tokenEnd <= previousEnd || tokenEnd <= tokenStart) {
            scanner.resetTokenState(Math.min(maskedText.length, tokenStart + 1));
            previousToken = undefined;
            previousEnd = tokenStart;
            continue;
        }
        previousEnd = tokenEnd;

        if (token === SyntaxKind.AnyKeyword && previousToken !== SyntaxKind.DotToken) {
            addHatch(tokenStart, previousToken === SyntaxKind.AsKeyword ? 'as any' : 'explicit any');
        }
        previousToken = token;
    }

    return hatches;
}

describe('TypeScript explicit any guard', () => {
    it('ignores banned words inside ordinary comments and string literals', () => {
        const sourceText = `
            const modelID = 'any-model';
            // any-model documents a fixture name and is not a directive.
        `;

        expect(findEscapeHatches('fixture.ts', sourceText)).toEqual([]);
    });

    it('reports real explicit any escapes and TypeScript suppression directives', () => {
        const sourceText = `
            const value: any = payload;
            const escaped = payload as any;
            // @ts-ignore
        `;

        expect(findEscapeHatches('fixture.ts', sourceText)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('explicit any'),
                expect.stringContaining('as any'),
                expect.stringContaining('@ts-ignore'),
            ]),
        );
    });

    it('changed TypeScript source contains no explicit any or ts-ignore escape hatches', () => {
        for (const rootDir of sourceRoots) {
            for (const file of collectFiles(rootDir)) {
                if (file.endsWith('tests/no-any.test.ts')) {
                    continue;
                }
                expect(findEscapeHatches(file, readFileSync(file, 'utf8')), `${file} contains an escape hatch`).toEqual(
                    [],
                );
            }
        }
    });
});
