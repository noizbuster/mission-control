import { describe, expect, it } from 'vitest';
import type { AstGrepMatch, AstGrepResult, AstGrepRunOptions } from './ast-grep-runner.js';
import { AstGrepRunnerError } from './ast-grep-runner.js';
import { type AstGrepOutput, astGrepParametersJsonSchema } from './ast-grep-schemas.js';
import {
    type AstGrepRunnerFn,
    type AstGrepToolOptions,
    createAstGrepToolRegistration,
    registerAstGrepTool,
} from './ast-grep-tool.js';
import { ToolExecutionError, ToolRegistry } from './tool-registry.js';

describe('ast_grep tool', () => {
    const baseOptions: AstGrepToolOptions = {
        workspaceRoot: '/workspace',
    };

    describe('createAstGrepToolRegistration', () => {
        it('produces a valid ToolRegistration with the ast_grep identity', () => {
            const registration = createAstGrepToolRegistration(baseOptions);

            expect(registration.name).toBe('ast_grep');
            expect(registration.capabilityClasses).toContain('read');
            expect(registration.description).toContain('ast-grep');
            expect(registration.outputLimit.maxModelOutputChars).toBe(8000);
            expect(registration.guideline).toContain('ast_grep');
        });

        it('exposes the ast_grep parameters JSON schema', () => {
            const registration = createAstGrepToolRegistration(baseOptions);

            expect(registration.parametersJsonSchema).toEqual(astGrepParametersJsonSchema());
        });

        it('binds input and output schemas from the shared contract', () => {
            const registration = createAstGrepToolRegistration(baseOptions);

            expect(registration.inputSchema.safeParse({ pattern: 'console.log($X)', paths: ['src'] }).success).toBe(
                true,
            );
            expect(registration.inputSchema.safeParse({ pattern: '', paths: ['src'] }).success).toBe(false);
            expect(registration.inputSchema.safeParse({ pattern: 'x', paths: [] }).success).toBe(false);
            expect(
                registration.outputSchema.safeParse({
                    matches: [],
                    filesSearched: 0,
                    filesWithMatches: 0,
                    truncated: false,
                }).success,
            ).toBe(true);
        });
    });

    describe('registerAstGrepTool', () => {
        it('registers the tool and advertises the ast_grep name with read capability', async () => {
            const registry = new ToolRegistry();

            const advertisement = await registerAstGrepTool(registry, baseOptions);

            expect(advertisement.name).toBe('ast_grep');
            expect(advertisement.capabilityClasses).toContain('read');
            expect(advertisement.outputLimit.maxModelOutputChars).toBe(8000);

            const advertised = registry.advertise().find((tool) => tool.name === 'ast_grep');
            expect(advertised).toBeDefined();
            expect(advertised?.capabilityClasses).toContain('read');
        });
    });

    describe('execute', () => {
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

            const output = await registration.execute(
                { pattern: 'console.log($X)', paths: ['src'] },
                executionContext(),
            );

            expect(output.matches).toHaveLength(2);
            expect(output.matches[0]?.path).toBe('src/a.ts');
            expect(output.matches[0]?.metaVariables).toEqual({ X: "'hi'" });
            expect(output.matches[1]?.path).toBe('src/b.ts');
            expect(output.matches[1]?.metaVariables).toBeUndefined();
            expect(output.filesWithMatches).toBe(2);
            expect(output.truncated).toBe(false);
        });

        it('wraps runner errors as retryable ToolExecutionError', async () => {
            const registration = createAstGrepToolRegistration({
                workspaceRoot: '/workspace',
                runner: failingRunner(new AstGrepRunnerError('not_installed', 'ast-grep is not installed')),
            });

            const caught = await captureError(() =>
                registration.execute({ pattern: 'x', paths: ['src'] }, executionContext()),
            );

            expect(caught).toBeInstanceOf(ToolExecutionError);
            const toolError = caught as ToolExecutionError;
            expect(toolError.error.code).toBe('tool_failed');
            expect(toolError.error.retryable).toBe(true);
            expect(toolError.error.message).toContain('ast_grep failed');
        });

        it('reports truncated=true and forwards parseErrors when the runner drops matches', async () => {
            const registration = createAstGrepToolRegistration({
                workspaceRoot: '/workspace',
                runner: succeedingRunner({
                    matches: [matchAt('src/one.ts', 5)],
                    filesSearched: 1,
                    filesWithMatches: 1,
                    parseErrors: ['result_truncated: 2 additional match(es) dropped after limit of 1'],
                }),
            });

            const output = await registration.execute(
                { pattern: 'console.log($X)', paths: ['src'] },
                executionContext(),
            );

            expect(output.truncated).toBe(true);
            expect(output.parseErrors).toEqual(['result_truncated: 2 additional match(es) dropped after limit of 1']);
        });

        it('returns empty matches without parseErrors when nothing matches', async () => {
            const registration = createAstGrepToolRegistration({
                workspaceRoot: '/workspace',
                runner: succeedingRunner({ matches: [], filesSearched: 0, filesWithMatches: 0 }),
            });

            const output = await registration.execute(
                { pattern: 'nonexistent($X)', paths: ['src'] },
                executionContext(),
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
            const registration = createAstGrepToolRegistration({
                workspaceRoot: '/ws',
                runner: captured.runner,
            });

            await registration.execute({ pattern: 'x', paths: ['src'] }, executionContext());

            expect(captured.lastOptions()?.language).toBeUndefined();
        });
    });

    describe('toModelOutput', () => {
        it('formats each match with a file:line:col prefix and metaVariables', () => {
            const registration = createAstGrepToolRegistration(baseOptions);
            const output: AstGrepOutput = {
                matches: [
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
                ],
                filesSearched: 2,
                filesWithMatches: 2,
                truncated: false,
            };

            const modelOutput = registration.toModelOutput?.(output) ?? '';

            expect(modelOutput).toContain("src/a.ts:5:1: console.log('hi')");
            expect(modelOutput).toContain("X: 'hi'");
            expect(modelOutput).toContain('src/b.ts:12:3: logger.info(msg)');
            expect(modelOutput).toContain('2 match(es)');
        });

        it('reports an empty result set without crashing', () => {
            const registration = createAstGrepToolRegistration(baseOptions);

            const modelOutput =
                registration.toModelOutput?.({
                    matches: [],
                    filesSearched: 0,
                    filesWithMatches: 0,
                    truncated: false,
                }) ?? '';

            expect(modelOutput.length).toBeGreaterThan(0);
            expect(modelOutput).toContain('no matches');
        });

        it('includes a truncation notice when the result was truncated', () => {
            const registration = createAstGrepToolRegistration(baseOptions);

            const modelOutput =
                registration.toModelOutput?.({
                    matches: [matchAt('src/one.ts', 5)],
                    filesSearched: 1,
                    filesWithMatches: 1,
                    truncated: true,
                }) ?? '';

            expect(modelOutput).toContain('truncated');
        });
    });

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function executionContext(): {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly signal: AbortSignal;
    } {
        return {
            toolCallId: 'ast_grep_call',
            toolName: 'ast_grep',
            signal: new AbortController().signal,
        };
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

    async function captureError(thunk: () => unknown | Promise<unknown>): Promise<unknown> {
        try {
            await thunk();
        } catch (error: unknown) {
            return error;
        }
        throw new Error('expected execute to throw');
    }
});
