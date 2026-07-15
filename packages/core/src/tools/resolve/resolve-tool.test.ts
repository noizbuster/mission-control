import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../../native/natives-client';
import { type AstRewriteFn, createAstEditToolRegistration } from '../ast-edit';
import { StagedPreviewRegistry } from '../staged-preview-registry';
import { ToolRegistry } from '../tool-registry';
import { createResolveToolRegistration, RESOLVE_TOOL_NAME, type ResolveOutput } from './resolve-tool';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaces: string[] = [];

describe('resolve tool (apply / discard staged preview)', () => {
    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('applies the queued preview atomically and clears the slot (propose-count == apply-count)', async () => {
        const workspaceRoot = await makeWorkspace();
        const source =
            'function a() { console.log(x); }\nfunction b() { console.log(y); }\nfunction c() { console.log(z); }\n';
        await writeFile(join(workspaceRoot, 'src.ts'), source, 'utf8');
        const absolutePath = join(workspaceRoot, 'src.ts');
        const content = Buffer.from(source);

        const rewriter = rewriterFrom([
            changeFor(content, 'console.log(x)', 'logger.info(x)', absolutePath),
            changeFor(content, 'console.log(y)', 'logger.info(y)', absolutePath),
            changeFor(content, 'console.log(z)', 'logger.info(z)', absolutePath),
        ]);
        const { registry, staged } = await setupBoth(workspaceRoot, rewriter);

        // 1) ast_edit proposes (no write).
        const propose = await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });
        expect(propose.result.status).toBe('completed');
        expect((propose.structuredOutput as { proposed: number }).proposed).toBe(3);
        expect(staged.hasPending).toBe(true);

        // 2) resolve applies.
        const apply = await invokeResolve(registry, { action: 'apply', reason: 'codemod approved' });

        expect(apply.result.status).toBe('completed');
        const out = apply.structuredOutput as ResolveOutput | undefined;
        expect(out?.status).toBe('applied');
        expect(out?.action).toBe('apply');
        expect(out?.proposedCount).toBe(3);
        expect(out?.applied).toEqual([{ path: 'src.ts', count: 3 }]);

        // The file is now patched with all three replacements.
        const patched = await readFile(absolutePath, 'utf8');
        expect(patched).toBe(
            'function a() { logger.info(x); }\nfunction b() { logger.info(y); }\nfunction c() { logger.info(z); }\n',
        );
        // Slot consumed after a successful apply.
        expect(staged.hasPending).toBe(false);
    });

    it('returns a clear error when applying with NO pending preview (no-op)', async () => {
        const workspaceRoot = await makeWorkspace();
        const rewriter = rewriterFrom([]);
        const { registry, staged } = await setupBoth(workspaceRoot, rewriter);

        const result = await invokeResolve(registry, { action: 'apply', reason: 'nothing staged' });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('pending');
        expect(staged.hasPending).toBe(false);
    });

    it('discards the queued preview WITHOUT writing', async () => {
        const workspaceRoot = await makeWorkspace();
        const source = 'console.log(x);\nconsole.log(y);\nconsole.log(z);\n';
        await writeFile(join(workspaceRoot, 'src.ts'), source, 'utf8');
        const absolutePath = join(workspaceRoot, 'src.ts');
        const content = Buffer.from(source);

        const rewriter = rewriterFrom([
            changeFor(content, 'console.log(x)', 'logger.info(x)', absolutePath),
            changeFor(content, 'console.log(y)', 'logger.info(y)', absolutePath),
            changeFor(content, 'console.log(z)', 'logger.info(z)', absolutePath),
        ]);
        const { registry, staged } = await setupBoth(workspaceRoot, rewriter);

        await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });
        expect(staged.hasPending).toBe(true);

        const result = await invokeResolve(registry, { action: 'discard', reason: 'changed my mind' });

        expect(result.result.status).toBe('completed');
        const out = result.structuredOutput as ResolveOutput | undefined;
        expect(out?.status).toBe('discarded');
        // No write happened: file is byte-identical.
        expect(await readFile(absolutePath, 'utf8')).toBe(source);
        expect(staged.hasPending).toBe(false);
    });

    it('reports nothing-to-discard (success) when discarding with no pending preview', async () => {
        const workspaceRoot = await makeWorkspace();
        const rewriter = rewriterFrom([]);
        const { registry } = await setupBoth(workspaceRoot, rewriter);

        const result = await invokeResolve(registry, { action: 'discard', reason: 'clearing' });

        expect(result.result.status).toBe('completed');
        const out = result.structuredOutput as ResolveOutput | undefined;
        expect(out?.status).toBe('nothing_pending');
    });

    it('rejects a stale preview: file drifted between propose and apply (no write)', async () => {
        const workspaceRoot = await makeWorkspace();
        const source = 'console.log(x);\nconsole.log(y);\nconsole.log(z);\n';
        await writeFile(join(workspaceRoot, 'src.ts'), source, 'utf8');
        const absolutePath = join(workspaceRoot, 'src.ts');
        const content = Buffer.from(source);

        // Propose sees 3; the 2nd rewriter call (the apply re-validation) sees
        // only 2 because the file drifted out-of-band.
        let call = 0;
        const rewriter: AstRewriteFn = () => {
            call += 1;
            const base = [
                changeFor(content, 'console.log(x)', 'logger.info(x)', absolutePath),
                changeFor(content, 'console.log(y)', 'logger.info(y)', absolutePath),
                changeFor(content, 'console.log(z)', 'logger.info(z)', absolutePath),
            ];
            return call === 1 ? base : base.slice(0, 2);
        };
        const { registry, staged } = await setupBoth(workspaceRoot, rewriter);

        await invokeAstEdit(registry, {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        });

        const result = await invokeResolve(registry, { action: 'apply', reason: 'approve' });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('stale');
        // No write happened despite the attempted apply.
        expect(await readFile(absolutePath, 'utf8')).toBe(source);
        // A failed apply clears the slot: the model must re-propose.
        expect(staged.hasPending).toBe(false);
    });

    it('is registered as a hidden coordination tool (edit capability class)', async () => {
        const workspaceRoot = await makeWorkspace();
        const rewriter = rewriterFrom([]);
        const { registry } = await setupBoth(workspaceRoot, rewriter);

        const advertisement = registry.advertise().find((tool) => tool.name === RESOLVE_TOOL_NAME);
        expect(advertisement?.capabilityClasses).toEqual(['edit']);
    });
});

async function makeWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'resolve-'));
    workspaces.push(workspace);
    return workspace;
}

async function setupBoth(
    workspaceRoot: string,
    rewriter: AstRewriteFn,
): Promise<{ readonly registry: ToolRegistry; readonly staged: StagedPreviewRegistry }> {
    const staged = new StagedPreviewRegistry();
    const registry = new ToolRegistry();
    registry.register(await createAstEditToolRegistration({ workspaceRoot, registry: staged, rewriter }));
    registry.register(createResolveToolRegistration({ registry: staged }));
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

async function invokeResolve(
    registry: ToolRegistry,
    input: { readonly action: 'apply' | 'discard'; readonly reason: string },
) {
    const advertisement = registry.advertise().find((tool) => tool.name === RESOLVE_TOOL_NAME);
    if (advertisement === undefined) {
        throw new TypeError('missing resolve advertisement');
    }
    return registry.invoke({
        toolCallId: 'resolve_call',
        toolName: RESOLVE_TOOL_NAME,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

/** Deterministic rewriter returning the same change set on every call. */
function rewriterFrom(changes: readonly NativeAstReplaceChange[]): AstRewriteFn {
    return () => [...changes];
}

/** Compute a NativeAstReplaceChange for one literal occurrence (see ast-edit.test.ts). */
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
