import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repositoryRoot = process.cwd();
const scanRoots = ['apps', 'packages', 'tests'] as const;
const relativeJsImportPattern = /(?:from|import)\s+['"]\.\.?\/[^'"]+\.js['"]|import\s*\(\s*['"]\.\.?\/[^'"]+\.js['"]\s*\)/u;

function listSourceFiles(directory: string): readonly string[] {
    const entries = readdirSync(directory);
    const files: string[] = [];
    for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'target') continue;
        const fullPath = join(directory, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            files.push(...listSourceFiles(fullPath));
            continue;
        }
        if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) continue;
        files.push(fullPath);
    }
    return files;
}

describe('extensionless relative imports (apps/packages/tests)', () => {
    it('forbids relative .js import/export/dynamic-import specifiers outside scripts/', () => {
        // Given production and test TypeScript under apps/, packages/, and tests/
        const offenders: string[] = [];
        for (const scanRoot of scanRoots) {
            const absoluteRoot = join(repositoryRoot, scanRoot);
            for (const filePath of listSourceFiles(absoluteRoot)) {
                const relativePath = relative(repositoryRoot, filePath);
                // Guard-test fixtures may embed .js strings as positive pins.
                if (relativePath === 'apps/cli/src/cli-entrypoint-import-cycle.test.ts') continue;
                if (relativePath === 'tests/extensionless-relative-imports.test.ts') continue;
                const source = readFileSync(filePath, 'utf8');
                if (relativeJsImportPattern.test(source)) {
                    offenders.push(relativePath);
                }
            }
        }

        // Then no relative .js module specifier remains (scripts/** is out of scope)
        expect(offenders).toEqual([]);
    });
});
