import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const stateSourceRoot = 'apps/tui/src/state';
const plainMarkdownSourceRoot = 'apps/tui/src/plain-markdown';
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/u;

function collectSourceFiles(dir: string): string[] {
    const absoluteDir = join(root, dir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        const relativePath = join(dir, entry);
        const absolutePath = join(root, relativePath);
        const stat = statSync(absolutePath);
        if (stat.isDirectory()) {
            files.push(...collectSourceFiles(relativePath));
            continue;
        }
        if (testFilePattern.test(entry)) continue;
        if (absolutePath.endsWith('.ts')) {
            files.push(relativePath);
        }
    }
    return files.sort();
}

const topLevelPureSourceFiles = [
    'apps/tui/src/index.ts',
    'apps/tui/src/terminal-text.ts',
    'apps/tui/src/chat.ts',
    'apps/tui/src/markdown.ts',
] as const;

/**
 * The PURE no-framework eager source files. These must never import opentui,
 * React, Solid, ffi, or anything from the CLI package. The opentui components
 * and platform code that land in `apps/tui/src/{components,platform}` are exempt —
 * the recursive CLI-boundary scan is the job of `tests/tui-cli-boundary.test.ts`.
 *
 * When a new pure subpath is added, append its top-level source path here or put
 * it under `src/state/` so the recursive guard covers it.
 */
const pureSourceFiles = [
    ...topLevelPureSourceFiles,
    ...collectSourceFiles(stateSourceRoot),
    ...collectSourceFiles(plainMarkdownSourceRoot),
].sort();

/**
 * Forbidden import strings. `react` is matched via its import-statement forms
 * (`from 'react'` / `from "react"`) so the bare substring does not flag
 * comments or unrelated identifiers.
 */
const forbiddenImportStrings = [
    '@opentui/core',
    '@opentui/react',
    '@opentui/solid',
    '@opentui/keymap',
    '@opentui/keymap/react',
    '@opentui/keymap/solid',
    'solid-js',
    'opentui-renderer',
    '@mission-control/tui/highlight',
    'apps/cli',
    '../cli',
    '../../cli',
    '@mission-control/cli',
    "from 'react'",
    'from "react"',
] as const;

const blockCommentPattern = /\/\*[\s\S]*?\*\//gu;
const lineCommentPattern = /\/\/.*$/gmu;

function stripComments(source: string): string {
    return source.replace(blockCommentPattern, '').replace(lineCommentPattern, '');
}

describe('apps/tui/src pure-subpath import-graph guard', () => {
    it('no pure/eager source file imports opentui, React, Solid, ffi, or apps/cli', () => {
        // Sanity: the guard must scan at least one real file; fail loudly if the
        // explicit list drifted to all-missing paths.
        expect(pureSourceFiles.length, 'pureSourceFiles must list at least one file').toBeGreaterThan(0);
        const failures: string[] = [];
        for (const relativePath of pureSourceFiles) {
            const absolutePath = join(root, relativePath);
            const source = stripComments(readFileSync(absolutePath, 'utf8'));
            for (const term of forbiddenImportStrings) {
                if (source.includes(term)) {
                    failures.push(`${relativePath}: forbidden import "${term}"`);
                }
            }
        }
        expect(failures, `pure/eager subpaths must not import opentui/react/solid/cli\n${failures.join('\n')}`).toEqual(
            [],
        );
    });

    it('keeps highlighting wired exclusively through the interactive markdown surface', () => {
        const componentSource = readFileSync(join(root, 'apps/tui/src/components/markdown/Markdown.tsx'), 'utf8');
        const themeSource = readFileSync(join(root, 'apps/tui/src/components/markdown/interactive-theme.ts'), 'utf8');

        expect(componentSource).toContain("from './highlight'");
        expect(themeSource).toContain("from './highlight'");
    });
});
