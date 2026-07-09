import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * Enforces that interactive TUI components and keymap layers never read terminal
 * dimensions directly via `process.stdout.columns/rows`. They must derive layout
 * from OpenTUI `useTerminalDimensions()` (width/height).
 *
 * Direct `process.stdout` reads are reserved for noninteractive stdout renderers
 * (which live in `apps/cli/src/ui/`) and low-level terminal seams that have
 * their own allow-list.
 */
const TERMINAL_GLOBAL_READ = /process\.std(?:out|err)\.(?:columns|rows)/;
const TUI_SOURCE_ROOT = resolve(process.cwd(), 'apps/tui/src');
const ALLOWED_TUI_TERMINAL_GLOBAL_FILES: readonly string[] = [];

function isRuntimeTypeScript(path: string): boolean {
    if (path.endsWith('.d.ts')) return false;
    if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) return false;
    return path.endsWith('.ts') || path.endsWith('.tsx');
}

function runtimeTypeScriptFiles(root: string): readonly string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const absolute = resolve(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...runtimeTypeScriptFiles(absolute));
        } else if (entry.isFile() && isRuntimeTypeScript(absolute)) {
            files.push(absolute);
        }
    }
    return files;
}

describe('TUI terminal dimension global policy', () => {
    it('keeps direct terminal dimension reads out of TUI components and keymap', () => {
        const filesWithDirectReads = runtimeTypeScriptFiles(TUI_SOURCE_ROOT)
            .filter((file) => TERMINAL_GLOBAL_READ.test(readFileSync(file, 'utf8')))
            .map((file) => relative(process.cwd(), file))
            .sort();

        expect(filesWithDirectReads).toEqual([...ALLOWED_TUI_TERMINAL_GLOBAL_FILES]);
    });
});
