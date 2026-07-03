import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../native/natives-client.js';
import type { AstRewriteFn } from './ast-edit.js';
import type { AstGrepMatch, AstGrepResult, AstGrepRunOptions } from './ast-grep-runner.js';
import { AstGrepRunnerError } from './ast-grep-runner.js';
import {
    type AstGrepOutput,
    type AstGrepQueryOutput,
    type AstGrepRewriteOutput,
    astGrepParametersJsonSchema,
} from './ast-grep-schemas.js';
import {
    type AstGrepRunnerFn,
    type AstGrepToolOptions,
    createAstGrepToolRegistration,
    registerAstGrepTool,
} from './ast-grep-tool.js';
import { createResolveToolRegistration } from './resolve/resolve-tool.js';
import { StagedPreviewRegistry } from './staged-preview-registry.js';
import { ToolExecutionError, ToolRegistry } from './tool-registry.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rewriteWorkspaces: string[] = [];

afterEach(async () => {
    await Promise.all(rewriteWorkspaces.map((ws) => rm(ws, { recursive: true, force: true })));
    rewriteWorkspaces.length = 0;
});

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

            const output = (await registration.execute(
                { pattern: 'console.log($X)', paths: ['src'] },
                executionContext(),
            )) as AstGrepQueryOutput;

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

            const output = (await registration.execute(
                { pattern: 'console.log($X)', paths: ['src'] },
                executionContext(),
            )) as AstGrepQueryOutput;

            expect(output.truncated).toBe(true);
            expect(output.parseErrors).toEqual(['result_truncated: 2 additional match(es) dropped after limit of 1']);
        });

        it('returns empty matches without parseErrors when nothing matches', async () => {
            const registration = createAstGrepToolRegistration({
                workspaceRoot: '/workspace',
                runner: succeedingRunner({ matches: [], filesSearched: 0, filesWithMatches: 0 }),
            });

            const output = (await registration.execute(
                { pattern: 'nonexistent($X)', paths: ['src'] },
                executionContext(),
            )) as AstGrepQueryOutput;

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

// ---------------------------------------------------------------------------
// Rewrite-preview mode (checkbox #14)
// ---------------------------------------------------------------------------

describe('ast_grep rewrite-preview mode', () => {
    it('proposes N replacements WITHOUT writing and stages a pending preview', async () => {
        const workspaceRoot = await makeRewriteWorkspace();
        const source = 'function a() { console.log(x); }\nfunction b() { console.log(y); }\n';
        const filePath = join(workspaceRoot, 'src.ts');
        await writeFile(filePath, source, 'utf8');
        const content = Buffer.from(source);

        const rewriter = makeRewriter([
            changeFor(content, 'console.log(x)', 'logger.info(x)', filePath),
            changeFor(content, 'console.log(y)', 'logger.info(y)', filePath),
        ]);
        const staged = new StagedPreviewRegistry();
        const registration = createAstGrepToolRegistration({
            workspaceRoot,
            registry: staged,
            rewriter,
        });

        const output = (await registration.execute(
            { pattern: 'console.log($X)', replacement: 'logger.info($X)', paths: ['src.ts'], mode: 'rewrite' },
            executionContext(),
        )) as AstGrepRewriteOutput;

        expect(output.mode).toBe('rewrite');
        expect(output.proposed).toBe(2);
        expect(output.files).toBe(1);
        expect(output.staged).toBe(true);
        expect(output.replacements).toEqual([{ path: 'src.ts', count: 2 }]);
        expect(output.message).toContain('proposed');

        // MUST NOT write: file is byte-identical to the pre-propose source.
        expect(await readFile(filePath, 'utf8')).toBe(source);
        expect(staged.hasPending).toBe(true);
        expect(staged.peek()?.summary.proposedCount).toBe(2);
        expect(staged.peek()?.summary.sourceToolName).toBe('ast_grep');
    });

    it('resolve applies the staged replacements to disk', async () => {
        const workspaceRoot = await makeRewriteWorkspace();
        const source = 'function a() { console.log(x); }\nfunction b() { console.log(y); }\n';
        const filePath = join(workspaceRoot, 'src.ts');
        await writeFile(filePath, source, 'utf8');
        const content = Buffer.from(source);

        const rewriter = makeRewriter([
            changeFor(content, 'console.log(x)', 'logger.info(x)', filePath),
            changeFor(content, 'console.log(y)', 'logger.info(y)', filePath),
        ]);
        const staged = new StagedPreviewRegistry();
        const registry = new ToolRegistry();
        registry.register(createAstGrepToolRegistration({ workspaceRoot, registry: staged, rewriter }));
        registry.register(createResolveToolRegistration({ registry: staged }));

        const astGrepAd = registry.advertise().find((t) => t.name === 'ast_grep')!;
        const resolveAd = registry.advertise().find((t) => t.name === 'resolve')!;

        await registry.invoke({
            toolCallId: 'call-1',
            toolName: 'ast_grep',
            advertisedVersion: astGrepAd.version,
            argumentsJson: JSON.stringify({
                pattern: 'console.log($X)',
                replacement: 'logger.info($X)',
                paths: ['src.ts'],
                mode: 'rewrite',
            }),
        });

        expect(staged.hasPending).toBe(true);

        const resolveResult = await registry.invoke({
            toolCallId: 'call-2',
            toolName: 'resolve',
            advertisedVersion: resolveAd.version,
            argumentsJson: JSON.stringify({ action: 'apply', reason: 'refactor logging' }),
        });

        expect(resolveResult.result.status).toBe('completed');
        expect(staged.hasPending).toBe(false);

        const after = await readFile(filePath, 'utf8');
        expect(after).toContain('logger.info(x)');
        expect(after).toContain('logger.info(y)');
        expect(after).not.toContain('console.log');
    });

    it('returns proposed:0 and does NOT stage when rewrite finds no matches', async () => {
        const workspaceRoot = await makeRewriteWorkspace();
        await writeFile(join(workspaceRoot, 'src.ts'), 'const x = 1;\n', 'utf8');

        const rewriter = makeRewriter([]);
        const staged = new StagedPreviewRegistry();
        const registration = createAstGrepToolRegistration({
            workspaceRoot,
            registry: staged,
            rewriter,
        });

        const output = (await registration.execute(
            { pattern: 'console.log($X)', replacement: 'logger.info($X)', paths: ['src.ts'], mode: 'rewrite' },
            executionContext(),
        )) as AstGrepRewriteOutput;

        expect(output.proposed).toBe(0);
        expect(output.staged).toBe(false);
        expect(staged.hasPending).toBe(false);
    });

    it('query mode is unchanged when mode is omitted', async () => {
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: succeedingRunner({
                matches: [matchAt('src/a.ts', 5)],
                filesSearched: 1,
                filesWithMatches: 1,
            }),
        });

        const output = (await registration.execute(
            { pattern: 'console.log($X)', paths: ['src'] },
            executionContext(),
        )) as AstGrepQueryOutput;

        expect(output.matches).toHaveLength(1);
        expect((output as { mode?: string }).mode).toBeUndefined();
    });

    async function makeRewriteWorkspace(): Promise<string> {
        const ws = await mkdtemp(join(tmpdir(), 'ast-grep-rewrite-'));
        rewriteWorkspaces.push(ws);
        return ws;
    }

    function makeRewriter(changes: readonly NativeAstReplaceChange[]): AstRewriteFn {
        return () => [...changes];
    }

    function changeFor(content: Buffer, before: string, after: string, absolutePath: string): NativeAstReplaceChange {
        const needle = Buffer.from(before, 'utf8');
        const byteStart = content.indexOf(needle);
        if (byteStart === -1) {
            throw new Error(`changeFor: ${before} not found`);
        }
        const byteEnd = byteStart + needle.length;
        const beforeSlice = content.subarray(0, byteStart).toString('utf8');
        const lines = beforeSlice.length === 0 ? [] : beforeSlice.split('\n');
        const startLine = lines.length + 1;
        const startColumn = (lines[lines.length - 1]?.length ?? 0) + 1;
        return {
            path: absolutePath,
            before,
            after,
            byteStart,
            byteEnd,
            startLine,
            startColumn,
            endLine: startLine,
            endColumn: startColumn + before.length,
        };
    }

    function executionContext(): {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly signal: AbortSignal;
    } {
        return { toolCallId: 'ast_grep_call', toolName: 'ast_grep', signal: new AbortController().signal };
    }

    function succeedingRunner(result: AstGrepResult): AstGrepRunnerFn {
        return async () => result;
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
});
