/**
 * ast_grep end-to-end integration tests (Wave 4, task 14).
 *
 * Drives `runAstGrep` against the REAL `sg` binary on the PATH using the DEFAULT
 * binary detector and executor (no mocking). Temp TypeScript files are written
 * under `os.tmpdir()`, searched structurally, and torn down after each test. The
 * suite skips itself when `sg` is unavailable so CI without the binary stays green.
 *
 * Coverage: single-file match, multi-file directory search, `--lang` override,
 * no-match empty result (exercises grep-like exit code 1), and metavariable
 * extraction ($NAME/$ARGS/$BODY) from the nested `metaVariables` envelope.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { runAstGrep } from './ast-grep-runner.js';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sgAvailable = detectSgBinary();
const workspaces: string[] = [];

describe.skipIf(!sgAvailable)('runAstGrep against the real sg binary', () => {
    afterEach(async () => {
        const pending = workspaces.splice(0, workspaces.length);
        await Promise.all(pending.map((workspace) => rm(workspace, { recursive: true, force: true })));
    });

    it('matches a function declaration pattern in a single file', async () => {
        // Given: a temp TS file declaring function foo() with empty parens
        const root = await createWorkspace({ 'sample.ts': SAMPLE_TS });

        // When: searching for the exact "function $NAME() { $$$ }" shape
        const result = await runAstGrep({
            pattern: 'function $NAME() { $$$ }',
            paths: ['sample.ts'],
            cwd: root,
        });

        // Then: only foo matches (bar has an argument list); positions are 1-indexed
        expect(result.matches).toHaveLength(1);
        const match = result.matches[0];
        expect(match?.path).toBe('sample.ts');
        expect(match?.text).toContain('function foo');
        expect(match?.startLine).toBe(1);
        expect(match?.startColumn).toBe(1);
    });

    it('searches across multiple files when given a directory path', async () => {
        // Given: a temp directory with two files each declaring a function
        const root = await createWorkspace({
            'src/alpha.ts': 'function alpha() {\n  return 1;\n}\n',
            'src/beta.ts': 'function beta(a, b) {\n  return a + b;\n}\n',
            'src/readme.txt': 'not typescript, no function here\n',
        });

        // When: searching the whole directory
        const result = await runAstGrep({
            pattern: 'function $NAME($$$ARGS) { $$$BODY }',
            paths: ['src'],
            cwd: root,
        });

        // Then: both .ts files contribute one match each; order is not asserted
        expect(result.matches).toHaveLength(2);
        expect(result.filesWithMatches).toBe(2);
        const paths = result.matches.map((match) => match.path).sort();
        expect(paths).toEqual(['src/alpha.ts', 'src/beta.ts']);
    });

    it('honours the --lang typescript override', async () => {
        // Given: a temp TS file and an explicit language override
        const root = await createWorkspace({ 'sample.ts': SAMPLE_TS });

        // When: searching with language: 'typescript'
        const result = await runAstGrep({
            pattern: 'function $NAME() { $$$ }',
            paths: ['sample.ts'],
            language: 'typescript',
            cwd: root,
        });

        // Then: the --lang flag is injected and the match is still found
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.text).toContain('function foo');
    });

    it('returns an empty result set when the pattern matches nothing', async () => {
        // Given: a temp TS file and a pattern that cannot match its contents
        const root = await createWorkspace({ 'sample.ts': SAMPLE_TS });

        // When: searching for a non-existent declaration (sg exits 1 for no matches)
        const result = await runAstGrep({
            pattern: 'function ZZZ_NONEXISTENT() { $$$BODY }',
            paths: ['sample.ts'],
            cwd: root,
        });

        // Then: no run_failed error; an authoritative empty result is returned
        expect(result.matches).toHaveLength(0);
        expect(result.filesWithMatches).toBe(0);
        expect(result.parseErrors).toBeUndefined();
    });

    it('extracts $NAME, $ARGS, and $BODY metavariables from a match', async () => {
        // Given: a temp TS file declaring function double(value)
        const root = await createWorkspace({ 'metavar.ts': 'function double(value) {\n  return value * 2;\n}\n' });

        // When: searching with a pattern that captures name, args, and body
        const result = await runAstGrep({
            pattern: 'function $NAME($$$ARGS) { $$$BODY }',
            paths: ['metavar.ts'],
            cwd: root,
        });

        // Then: the nested metaVariables envelope is flattened into typed captures
        expect(result.matches).toHaveLength(1);
        const meta = result.matches[0]?.metaVariables;
        expect(meta?.['NAME']).toBe('double');
        expect(meta?.['ARGS']).toBe('value');
        expect(meta?.['BODY']).toBe('return value * 2;');
    });
});

const SAMPLE_TS = [
    'function foo() {',
    '  return 1;',
    '}',
    '',
    'function bar(x) {',
    '  return x + 1;',
    '}',
    '',
    'const arrow = () => 42;',
    '',
].join('\n');

async function createWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-astgrep-'));
    workspaces.push(root);
    for (const [relPath, content] of Object.entries(files)) {
        const abs = join(root, relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
    }
    return root;
}

function detectSgBinary(): boolean {
    try {
        const result = spawnSync('sg', ['--version'], { encoding: 'utf8', windowsHide: true });
        return result.status === 0 && (result.stdout ?? '').trim().length > 0;
    } catch {
        return false;
    }
}
