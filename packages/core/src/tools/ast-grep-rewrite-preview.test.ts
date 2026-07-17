import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../native/natives-client';
import type { AstRewriteFn } from './ast-edit';
import type { AstGrepMatch, AstGrepResult } from './ast-grep-runner';
import { type AstGrepOutput, type AstGrepQueryOutput, type AstGrepRewriteOutput } from './ast-grep-schemas';
import { type AstGrepRunnerFn, createAstGrepToolRegistration } from './ast-grep-tool';
import { createResolveToolRegistration } from './resolve/resolve-tool';
import { StagedPreviewRegistry } from './staged-preview-registry';
import { ToolRegistry } from './tool-registry';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaces: string[] = [];

afterEach(async () => {
    await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
    workspaces.length = 0;
});

describe('ast_grep rewrite-preview mode', () => {
    it('proposes replacements without writing and stages a pending preview', async () => {
        const workspaceRoot = await makeWorkspace();
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
            requestPermission: allowPermission,
        });

        const output = rewriteOutput(
            await registration.execute(
                { pattern: 'console.log($X)', replacement: 'logger.info($X)', paths: ['src.ts'], mode: 'rewrite' },
                executionContext(),
            ),
        );

        expect(output.mode).toBe('rewrite');
        expect(output.proposed).toBe(2);
        expect(output.files).toBe(1);
        expect(output.staged).toBe(true);
        expect(output.replacements).toEqual([{ path: 'src.ts', count: 2 }]);
        expect(output.message).toContain('proposed');
        expect(await readFile(filePath, 'utf8')).toBe(source);
        expect(staged.hasPending).toBe(true);
        expect(staged.peek()?.summary.proposedCount).toBe(2);
        expect(staged.peek()?.summary.sourceToolName).toBe('ast_grep');
    });

    it('resolve applies the staged replacements to disk', async () => {
        const workspaceRoot = await makeWorkspace();
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
        registry.register(
            createAstGrepToolRegistration({
                workspaceRoot,
                registry: staged,
                rewriter,
                requestPermission: allowPermission,
            }),
        );
        registry.register(createResolveToolRegistration({ registry: staged }));
        const astGrepAdvertisement = registry.advertise().find((tool) => tool.name === 'ast_grep');
        const resolveAdvertisement = registry.advertise().find((tool) => tool.name === 'resolve');
        if (astGrepAdvertisement === undefined || resolveAdvertisement === undefined) {
            throw new TypeError('staged preview tools were not advertised');
        }
        await registry.invoke({
            toolCallId: 'call-1',
            toolName: 'ast_grep',
            advertisedVersion: astGrepAdvertisement.version,
            argumentsJson: JSON.stringify({
                pattern: 'console.log($X)',
                replacement: 'logger.info($X)',
                paths: ['src.ts'],
                mode: 'rewrite',
            }),
        });

        const resolveResult = await registry.invoke({
            toolCallId: 'call-2',
            toolName: 'resolve',
            advertisedVersion: resolveAdvertisement.version,
            argumentsJson: JSON.stringify({ action: 'apply', reason: 'refactor logging' }),
        });

        expect(resolveResult.result.status).toBe('completed');
        expect(staged.hasPending).toBe(false);
        const after = await readFile(filePath, 'utf8');
        expect(after).toContain('logger.info(x)');
        expect(after).toContain('logger.info(y)');
        expect(after).not.toContain('console.log');
    });

    it('does not stage when rewrite finds no matches', async () => {
        const workspaceRoot = await makeWorkspace();
        await writeFile(join(workspaceRoot, 'src.ts'), 'const x = 1;\n', 'utf8');
        const staged = new StagedPreviewRegistry();
        const registration = createAstGrepToolRegistration({
            workspaceRoot,
            registry: staged,
            rewriter: makeRewriter([]),
            requestPermission: allowPermission,
        });

        const output = rewriteOutput(
            await registration.execute(
                { pattern: 'console.log($X)', replacement: 'logger.info($X)', paths: ['src.ts'], mode: 'rewrite' },
                executionContext(),
            ),
        );

        expect(output.proposed).toBe(0);
        expect(output.staged).toBe(false);
        expect(staged.hasPending).toBe(false);
    });

    it('keeps query mode unchanged when mode is omitted', async () => {
        const registration = createAstGrepToolRegistration({
            workspaceRoot: '/workspace',
            runner: succeedingRunner({
                matches: [matchAt('src/a.ts', 5)],
                filesSearched: 1,
                filesWithMatches: 1,
            }),
        });

        const output = queryOutput(
            await registration.execute({ pattern: 'console.log($X)', paths: ['src'] }, executionContext()),
        );

        expect(output.matches).toHaveLength(1);
        expect('mode' in output).toBe(false);
    });
});

function rewriteOutput(output: AstGrepOutput): AstGrepRewriteOutput {
    if ('mode' in output) return output;
    throw new TypeError('rewrite mode returned query output');
}

function queryOutput(output: AstGrepOutput): AstGrepQueryOutput {
    if ('matches' in output) return output;
    throw new TypeError('query mode returned rewrite output');
}

async function makeWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'ast-grep-rewrite-'));
    workspaces.push(workspace);
    return workspace;
}

function makeRewriter(changes: readonly NativeAstReplaceChange[]): AstRewriteFn {
    return () => [...changes];
}

async function allowPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return { requestId: request.id, status: 'allow', reason: 'ast_grep test approval' };
}

function changeFor(content: Buffer, before: string, after: string, absolutePath: string): NativeAstReplaceChange {
    const needle = Buffer.from(before, 'utf8');
    const byteStart = content.indexOf(needle);
    if (byteStart === -1) throw new Error(`changeFor: ${before} not found`);
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

function executionContext(): { readonly toolCallId: string; readonly toolName: string; readonly signal: AbortSignal } {
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
