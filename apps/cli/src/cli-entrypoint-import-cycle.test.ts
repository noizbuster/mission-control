import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The CLI entrypoint (`src/index.tsx`) uses top-level `await runCli()`. Any
 * static import of that module from a module loaded during `runCli()` deadlocks
 * ESM evaluation and exits with Node status 13 (unsettled top-level await).
 *
 * Production command modules must import product metadata from `cli-version.ts`
 * (or another non-entrypoint module), never from `../index`, `../index.js`,
 * `./index`, or `./index.js`.
 */
const repositoryRoot = process.cwd();
const cliSrcRoot = join(repositoryRoot, 'apps/cli/src');
const entrypointRelative = 'apps/cli/src/index.tsx';
/** Alternate bin wrapper: an entrypoint itself, never imported during runCli. */
const launcherRelative = 'apps/cli/src/package-script-launcher.ts';
// Match relative entrypoint forms with or without a trailing `.js` extension.
const entrypointImportPattern =
    /(?:from|import)\s+['"](?:\.\.\/)+index(?:\.js)?['"]|(?:from|import)\s+['"]\.\/index(?:\.js)?['"]/u;

function listSourceFiles(directory: string): readonly string[] {
    const entries = readdirSync(directory);
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(directory, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            files.push(...listSourceFiles(fullPath));
            continue;
        }
        if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) continue;
        if (fullPath.endsWith('.test.ts') || fullPath.endsWith('.test.tsx')) continue;
        files.push(fullPath);
    }
    return files;
}

describe('CLI entrypoint import cycle guard', () => {
    it('keeps production command modules from static-importing the entrypoint', () => {
        // Given production sources under apps/cli/src (excluding tests + entrypoint)
        const offenders: string[] = [];
        for (const filePath of listSourceFiles(cliSrcRoot)) {
            const relativePath = relative(repositoryRoot, filePath);
            if (relativePath === entrypointRelative || relativePath === launcherRelative) continue;
            const source = readFileSync(filePath, 'utf8');
            if (entrypointImportPattern.test(source)) {
                offenders.push(relativePath);
            }
        }

        // Then none re-import the entrypoint (would deadlock top-level await runCli)
        expect(offenders).toEqual([]);
    });

    it('flags both bare and .js-suffixed relative entrypoint imports', () => {
        // Given synthetic sources that static-import the entrypoint under both forms
        const bareParent = "import { getVersion } from '../index';\n";
        const jsParent = "import { getVersion } from '../index.js';\n";
        const bareLocal = "export { runCli } from './index';\n";
        const jsLocal = "export { runCli } from './index.js';\n";
        const safe = "import { getVersion } from '../cli-version';\n";

        // Then the guard pattern matches every entrypoint form and ignores safe modules
        expect(entrypointImportPattern.test(bareParent)).toBe(true);
        expect(entrypointImportPattern.test(jsParent)).toBe(true);
        expect(entrypointImportPattern.test(bareLocal)).toBe(true);
        expect(entrypointImportPattern.test(jsLocal)).toBe(true);
        expect(entrypointImportPattern.test(safe)).toBe(false);
    });

    it('exposes getVersion from the non-entrypoint cli-version module', () => {
        // Given the extracted version module
        const source = readFileSync(join(cliSrcRoot, 'cli-version.ts'), 'utf8');

        // Then it exports getVersion without importing the entrypoint
        expect(source).toContain('export function getVersion');
        expect(source).not.toMatch(entrypointImportPattern);
    });
});
