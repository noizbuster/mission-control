import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../native/natives-client';
import { type AstRewriteFn, createAstEditToolRegistration } from './ast-edit';
import { type AstEditOutput, astEditInputSchema } from './ast-edit-schemas';
import { StagedPreviewRegistry } from './staged-preview-registry';
import { ToolRegistry } from './tool-registry';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaces: string[] = [];

describe('ast_edit tool (propose, no write)', () => {
    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('proposes N replacements WITHOUT writing and stages a pending preview', async () => {
        const workspaceRoot = await makeWorkspace();
        const source =
            'function a() { console.log(x); }\nfunction b() { console.log(y); }\nfunction c() { console.log(z); }\n';
        await writeFile(join(workspaceRoot, 'src.ts'), source, 'utf8');
        const beforePath = join(workspaceRoot, 'src.ts');
        const content = Buffer.from(source);

        // Three structural replacements: console.log($X) -> logger.info($X)
        const rewriter = makeRewriter([
            changeFor(content, 'console.log(x)', 'logger.info(x)', beforePath),
            changeFor(content, 'console.log(y)', 'logger.info(y)', beforePath),
            changeFor(content, 'console.log(z)', 'logger.info(z)', beforePath),
        ]);
        const { registry, staged } = await setupAstEdit(workspaceRoot, rewriter);

        const result = await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });

        expect(result.result.status).toBe('completed');
        const output = result.structuredOutput as AstEditOutput | undefined;
        expect(output?.proposed).toBe(3);
        expect(output?.files).toBe(1);
        expect(output?.staged).toBe(true);
        expect(output?.replacements).toEqual([{ path: 'src.ts', count: 3 }]);
        // (proposed) N replacements wording, surfaced to the model.
        expect(output?.message).toContain('proposed');
        expect(output?.message).toContain('3');

        // MUST NOT write: file content is byte-identical to the pre-propose source.
        expect(await readFile(beforePath, 'utf8')).toBe(source);
        // The preview is staged for `resolve` to commit.
        expect(staged.hasPending).toBe(true);
        expect(staged.peek()?.summary.proposedCount).toBe(3);
    });

    it('returns proposed:0 and does NOT stage when there are no matches', async () => {
        const workspaceRoot = await makeWorkspace();
        await writeFile(join(workspaceRoot, 'src.ts'), 'const x = 1;\n', 'utf8');
        const rewriter = makeRewriter([]);
        const { registry, staged } = await setupAstEdit(workspaceRoot, rewriter);

        const result = await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });

        expect(result.result.status).toBe('completed');
        const output = result.structuredOutput as AstEditOutput | undefined;
        expect(output?.proposed).toBe(0);
        expect(output?.staged).toBe(false);
        expect(staged.hasPending).toBe(false);
    });

    it('surfaces a tool failure when the ast module is unavailable', async () => {
        const workspaceRoot = await makeWorkspace();
        await writeFile(join(workspaceRoot, 'src.ts'), 'console.log(x);\n', 'utf8');
        // Simulate the N-API addon returning null (unavailable / predates ast module).
        const rewriter: AstRewriteFn = () => {
            throw new Error('ast module unavailable');
        };
        const { registry, staged } = await setupAstEdit(workspaceRoot, rewriter);

        const result = await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('ast');
        expect(staged.hasPending).toBe(false);
    });

    it('rejects an empty pattern at the schema boundary', () => {
        const parsed = astEditInputSchema.safeParse({
            pattern: '',
            replacement: 'x',
            paths: ['src.ts'],
        });
        expect(parsed.success).toBe(false);
    });

    it('self-gates as a file.edit write-tier tool', async () => {
        const workspaceRoot = await makeWorkspace();
        await writeFile(join(workspaceRoot, 'src.ts'), 'console.log(x);\n', 'utf8');
        const rewriter = makeRewriter([]);
        const { registry } = await setupAstEdit(workspaceRoot, rewriter);

        const advertisement = registry.advertise().find((tool) => tool.name === 'ast_edit');
        expect(advertisement?.capabilityClasses).toEqual(['file.edit']);
    });
});

async function makeWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'ast-edit-'));
    workspaces.push(workspace);
    return workspace;
}

async function setupAstEdit(
    workspaceRoot: string,
    rewriter: AstRewriteFn,
): Promise<{ readonly registry: ToolRegistry; readonly staged: StagedPreviewRegistry }> {
    const staged = new StagedPreviewRegistry();
    const registry = new ToolRegistry();
    registry.register(await createAstEditToolRegistration({ workspaceRoot, registry: staged, rewriter }));
    return { registry, staged };
}

async function invokeAstEdit(
    registry: ToolRegistry,
    input: { readonly pattern: string; readonly replacement: string; readonly paths: readonly string[] },
) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'ast_edit');
    if (advertisement === undefined) {
        throw new TypeError('missing ast_edit advertisement');
    }
    return registry.invoke({
        toolCallId: 'ast_edit_call',
        toolName: 'ast_edit',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

/** Build a deterministic rewriter over a fixed change set. */
function makeRewriter(changes: readonly NativeAstReplaceChange[]): AstRewriteFn {
    return () => [...changes];
}

/**
 * Compute a NativeAstReplaceChange for one literal occurrence in `content`,
 * matching the byte-range contract the real N-API astRewrite returns.
 */
function changeFor(
    content: Buffer,
    before: string,
    after: string,
    absolutePath: string,
    occurrence = 0,
): NativeAstReplaceChange {
    const needle = Buffer.from(before, 'utf8');
    let from = 0;
    let byteStart = -1;
    for (let i = 0; i <= occurrence; i += 1) {
        byteStart = content.indexOf(needle, from);
        if (byteStart === -1) {
            throw new Error(`changeFor: occurrence ${i} of ${before} not found`);
        }
        from = byteStart + needle.length;
    }
    const byteEnd = byteStart + needle.length;
    // 1-indexed line/column derived from the byte offset, mirroring ast-grep.
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
