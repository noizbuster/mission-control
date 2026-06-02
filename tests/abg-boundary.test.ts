import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function collectSourceFiles(dir: string): string[] {
    const absoluteDir = join(root, dir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        const path = join(absoluteDir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            files.push(...collectSourceFiles(path.slice(root.length + 1)));
            continue;
        }
        if (path.endsWith('.ts') || path.endsWith('.tsx')) {
            files.push(path);
        }
    }
    return files;
}

describe('ABG runtime boundaries', () => {
    it('core runtime has no imports from CLI desktop or React UI', () => {
        const forbidden = ['apps/cli', 'apps/desktop', '@mission-control/cli', '@mission-control/desktop', 'react'];

        for (const file of collectSourceFiles('packages/core/src')) {
            const source = readFileSync(file, 'utf8');
            for (const term of forbidden) {
                expect(source, `${file} must not depend on ${term}`).not.toContain(term);
            }
        }
    });
});
