import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const tuiSourceRoot = 'apps/tui/src';

/**
 * Regex patterns that match actual CLI import/reference edges, not substrings of legitimate
 * paths. The negative lookahead `(?![a-zA-Z])` prevents `../cli` from matching
 * `../clipboard-service.js` (the `p` in `clip` is a letter, so it fails).
 */
const forbiddenCliPatterns: readonly RegExp[] = [
    /apps\/cli(?![a-zA-Z])/,
    /\.\.\/cli(?![a-zA-Z])/,
    /\.\.\/\.\.\/cli(?![a-zA-Z])/,
    /@mission-control\/cli(?![a-zA-Z])/,
];

// Test files legitimately reference the forbidden strings as assertion data;
// the boundary scan targets non-test source only.
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/u;

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
        if (testFilePattern.test(entry)) continue;
        if (path.endsWith('.ts') || path.endsWith('.tsx')) {
            files.push(path);
        }
    }
    return files;
}

describe('TUI -> CLI boundary', () => {
    if (!existsSync(join(root, tuiSourceRoot))) {
        it.skip('apps/tui/src not yet created — will activate after Todo 2', () => {});
        return;
    }

    it('no source file under apps/tui/src references apps/cli or @mission-control/cli', () => {
        const failures: string[] = [];
        for (const file of collectSourceFiles(tuiSourceRoot)) {
            const source = readFileSync(file, 'utf8');
            for (const pattern of forbiddenCliPatterns) {
                const match = pattern.exec(source);
                if (match !== null) {
                    failures.push(`${file}: forbidden CLI reference "${match[0]}"`);
                }
            }
        }
        expect(failures, `TUI source must not reference CLI\n${failures.join('\n')}`).toEqual([]);
    });
});
