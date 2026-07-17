import { describe, expect, it } from 'vitest';
import type { AstGrepMatch, AstGrepResult, AstGrepRunOptions } from './ast-grep-runner';
import { AstGrepRunnerError } from './ast-grep-runner';
import type { AstGrepOutput, AstGrepQueryOutput } from './ast-grep-schemas';
import { type AstGrepRunnerFn, createAstGrepToolRegistration } from './ast-grep-tool';
import { StagedPreviewRegistry } from './staged-preview-registry';

describe('ast_grep query execution', () => {
    it('returns structured matches when the runner succeeds', async () => {
        const matches: readonly AstGrepMatch[] = [
            {
                path: 'src/a.ts',
                text: "console.log('hi')",
                startLine: 5,
                startColumn: 1,
                endLine: 5,
                endColumn: 20,
                metaVariables: { X: "'hi'" },
            },
            {
                path: 'src/b.ts',
                text: 'logger.info(msg)',
                startLine: 12,
                startColumn: 3,
                endLine: 12,
                endColumn: 19,
            },
        ];
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: succeedingRunner({ matches, filesSearched: 2, filesWithMatches: 2 }),
        });

        const output = queryOutput(
            await registration.execute({ pattern: 'console.log($X)', paths: ['src'] }, executionContext()),
        );

        expect(output.matches).toHaveLength(2);
        expect(output.matches[0]?.path).toBe('src/a.ts');
        expect(output.matches[0]?.metaVariables).toEqual({ X: "'hi'" });
        expect(output.matches[1]?.path).toBe('src/b.ts');
        expect(output.matches[1]?.metaVariables).toBeUndefined();
        expect(output.filesWithMatches).toBe(2);
        expect(output.truncated).toBe(false);
    });

    it('wraps runner errors as retryable tool failures', async () => {
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: failingRunner(new AstGrepRunnerError('not_installed', 'ast-grep is not installed')),
        });

        const execution = registration.execute({ pattern: 'x', paths: ['src'] }, executionContext());

        await expect(execution).rejects.toMatchObject({
            error: {
                code: 'tool_failed',
                retryable: true,
                message: expect.stringContaining('ast_grep failed'),
            },
        });
    });

    it('reports truncation and forwards parse errors when the runner drops matches', async () => {
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: succeedingRunner({
                matches: [matchAt('src/one.ts', 5)],
                filesSearched: 1,
                filesWithMatches: 1,
                parseErrors: ['result_truncated: 2 additional match(es) dropped after limit of 1'],
            }),
        });

        const output = queryOutput(
            await registration.execute({ pattern: 'console.log($X)', paths: ['src'] }, executionContext()),
        );

        expect(output.truncated).toBe(true);
        expect(output.parseErrors).toEqual(['result_truncated: 2 additional match(es) dropped after limit of 1']);
    });

    it('returns empty matches without parse errors when nothing matches', async () => {
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: succeedingRunner({ matches: [], filesSearched: 0, filesWithMatches: 0 }),
        });

        const output = queryOutput(
            await registration.execute({ pattern: 'nonexistent($X)', paths: ['src'] }, executionContext()),
        );

        expect(output.matches).toHaveLength(0);
        expect(output.filesWithMatches).toBe(0);
        expect(output.truncated).toBe(false);
        expect(output.parseErrors).toBeUndefined();
    });

    it('passes language and workspace root through to the runner', async () => {
        const captured = captureRunOptions();
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/custom-workspace',
            runner: captured.runner,
        });

        await registration.execute({ pattern: 'fn($X)', paths: ['src'], language: 'Rust' }, executionContext());

        expect(captured.lastOptions()?.pattern).toBe('fn($X)');
        expect(captured.lastOptions()?.paths).toEqual(['src']);
        expect(captured.lastOptions()?.language).toBe('Rust');
        expect(captured.lastOptions()?.cwd).toBe('/custom-workspace');
    });

    it('omits language from runner options when input does not specify it', async () => {
        const captured = captureRunOptions();
        const registration = createAstGrepToolRegistration({ workspaceRoot: '/ws', runner: captured.runner });

        await registration.execute({ pattern: 'x', paths: ['src'] }, executionContext());

        expect(captured.lastOptions()?.language).toBeUndefined();
    });

    it('keeps query mode read-only when staged rewrite dependencies are present', async () => {
        const staged = new StagedPreviewRegistry();
        const permissionRequests: string[] = [];
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            registry: staged,
            runner: succeedingRunner({
                matches: [matchAt('src/a.ts', 5)],
                filesSearched: 1,
                filesWithMatches: 1,
            }),
            requestPermission: async (request) => {
                permissionRequests.push(request.id);
                return { requestId: request.id, status: 'allow', reason: 'query should not request permission' };
            },
        });

        const output = queryOutput(
            await registration.execute({ pattern: 'console.log($X)', paths: ['src'] }, executionContext()),
        );

        expect(output.matches).toHaveLength(1);
        expect(permissionRequests).toEqual([]);
        expect(staged.hasPending).toBe(false);
    });
});

function queryOutput(output: AstGrepOutput): AstGrepQueryOutput {
    if ('matches' in output) return output;
    throw new TypeError('query mode returned rewrite output');
}

function executionContext(): { readonly toolCallId: string; readonly toolName: string; readonly signal: AbortSignal } {
    return { toolCallId: 'ast_grep_call', toolName: 'ast_grep', signal: new AbortController().signal };
}

function succeedingRunner(result: AstGrepResult): AstGrepRunnerFn {
    return async () => result;
}

function failingRunner(error: Error): AstGrepRunnerFn {
    return async () => {
        throw error;
    };
}

function captureRunOptions(): {
    readonly runner: AstGrepRunnerFn;
    readonly lastOptions: () => AstGrepRunOptions | undefined;
} {
    let last: AstGrepRunOptions | undefined;
    const runner: AstGrepRunnerFn = async (options) => {
        last = options;
        return { matches: [], filesSearched: 0, filesWithMatches: 0 };
    };
    return { runner, lastOptions: () => last };
}

function matchAt(path: string, line: number): AstGrepMatch {
    return {
        path,
        text: `match-${path}`,
        startLine: line,
        startColumn: 1,
        endLine: line,
        endColumn: 10,
    };
}
