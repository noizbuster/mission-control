import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sourceRoots = ['packages', 'apps', 'scripts', 'tests'] as const;

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

describe('TypeScript explicit any guard', () => {
    it('changed TypeScript source contains no explicit any or ts-ignore escape hatches', () => {
        const pattern = /\bany\b|@ts-ignore|@ts-expect-error|as unknown|as any/;
        for (const rootDir of sourceRoots) {
            for (const file of collectFiles(rootDir)) {
                if (file.endsWith('tests/no-any.test.ts')) {
                    continue;
                }
                expect(readFileSync(file, 'utf8'), `${file} contains an escape hatch`).not.toMatch(pattern);
            }
        }
    });
});
