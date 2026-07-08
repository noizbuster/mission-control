import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * CLI-side terminal-dimension policy: only the noninteractive renderer (`renderers.ts`) may read
 * `process.stdout.columns/rows` directly. All other CLI runtime files must not.
 *
 * The interactive TUI components and keymap layers (now in `apps/tui`) have their own
 * version of this guard in `apps/tui/src/platform/terminal-global-policy.test.ts`.
 */
const TERMINAL_GLOBAL_READ = /process\.std(?:out|err)\.(?:columns|rows)/;
const CLI_SOURCE_ROOT = resolve(process.cwd(), 'apps/cli/src');
const ALLOWED_CLI_TERMINAL_GLOBAL_FILES = ['apps/cli/src/ui/renderers.ts'] as const;

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

describe('CLI terminal dimension global policy', () => {
    it('keeps direct terminal dimension reads out of CLI runtime files except the noninteractive renderer', () => {
        const filesWithDirectReads = runtimeTypeScriptFiles(CLI_SOURCE_ROOT)
            .filter((file) => TERMINAL_GLOBAL_READ.test(readFileSync(file, 'utf8')))
            .map((file) => relative(process.cwd(), file))
            .sort();

        expect(filesWithDirectReads).toEqual([...ALLOWED_CLI_TERMINAL_GLOBAL_FILES]);
    });
});
