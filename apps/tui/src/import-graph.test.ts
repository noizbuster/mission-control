import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const root = process.cwd();

/**
 * The PURE no-OpenTUI subpath source files. These must never import opentui,
 * react, ffi, or anything from the CLI package. The opentui components and
 * platform code that land in `apps/tui/src/{components,platform}` are exempt —
 * the recursive CLI-boundary scan is the job of `tests/tui-cli-boundary.test.ts`.
 *
 * When a new pure subpath is added, append its source path here so the guard
 * covers it.
 */
const pureSourceFiles = ['apps/tui/src/terminal-text.ts', 'apps/tui/src/chat.ts', 'apps/tui/src/markdown.ts'];

/**
 * Forbidden import strings. `react` is matched via its import-statement forms
 * (`from 'react'` / `from "react"`) so the bare substring does not flag
 * comments or unrelated identifiers.
 */
const forbiddenImportStrings = [
    '@opentui/core',
    '@opentui/react',
    '@opentui/keymap',
    'opentui-renderer',
    'apps/cli',
    '../cli',
    '../../cli',
    '@mission-control/cli',
    "from 'react'",
    'from "react"',
] as const;

describe('apps/tui/src pure-subpath import-graph guard', () => {
    it('no pure subpath source file imports opentui, react, ffi, or apps/cli', () => {
        // Sanity: the guard must scan at least one real file; fail loudly if the
        // explicit list drifted to all-missing paths.
        expect(pureSourceFiles.length, 'pureSourceFiles must list at least one file').toBeGreaterThan(0);
        const failures: string[] = [];
        for (const relativePath of pureSourceFiles) {
            const absolutePath = `${root}/${relativePath}`;
            const source = readFileSync(absolutePath, 'utf8');
            for (const term of forbiddenImportStrings) {
                if (source.includes(term)) {
                    failures.push(`${relativePath}: forbidden import "${term}"`);
                }
            }
        }
        expect(failures, `pure subpaths must not import opentui/react/cli\n${failures.join('\n')}`).toEqual([]);
    });
});
