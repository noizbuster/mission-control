import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../native/natives-client';
import { applyStagedAstEdit } from './ast-edit-apply';
import type { AstRewriteFn } from './ast-edit-rewriter';
import { createPatchWorkspaceGuard } from './file-patch-paths';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('staged AST apply safety', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('rejects same-count content drift introduced during approval', async () => {
        // Given
        const workspaceRoot = await makeWorkspace();
        const targetPath = join(workspaceRoot, 'source.ts');
        const source = 'console.log(x);\n';
        const drifted = '// shifted\nconsole.log(x);\n';
        await writeFile(targetPath, source, 'utf8');
        const proposed = changeFor(Buffer.from(source), 'console.log(x)', 'logger.info(x)', targetPath);
        const shifted = changeFor(Buffer.from(drifted), 'console.log(x)', 'logger.info(x)', targetPath);
        let rewriteCall = 0;
        const rewriter: AstRewriteFn = () => {
            rewriteCall += 1;
            return [rewriteCall === 1 ? proposed : shifted];
        };
        const guard = await createPatchWorkspaceGuard(workspaceRoot);

        // When
        const apply = applyStagedAstEdit({
            reason: 'apply approved rewrite',
            resolveToolCallId: 'resolve_drift',
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            files: [targetPath],
            workspaceRoot,
            guard,
            rewriter,
            proposedCount: 1,
            proposedReplacements: [{ path: 'source.ts', count: 1 }],
            proposedChanges: [proposed],
            requestPermission: async (request) => {
                await writeFile(targetPath, drifted, 'utf8');
                return allowPermission(request);
            },
        });

        // Then
        await expect(apply).rejects.toThrow(/stale/i);
        expect(await readFile(targetPath, 'utf8')).toBe(drifted);
    });

    it('serializes concurrent applies on the canonical workspace queue', async () => {
        // Given
        const workspaceRoot = await makeWorkspace();
        const targetPath = join(workspaceRoot, 'source.ts');
        const source = 'console.log(x);\n';
        await writeFile(targetPath, source, 'utf8');
        const proposed = changeFor(Buffer.from(source), 'console.log(x)', 'logger.info(x)', targetPath);
        const guard = await createPatchWorkspaceGuard(workspaceRoot);
        const phases: string[] = [];
        const firstApprovalSeen = deferred<void>();
        const releaseFirstApproval = deferred<void>();
        const rewriter: AstRewriteFn = () => {
            phases.push('rewrite');
            const current = readFileSync(targetPath);
            return current.includes(Buffer.from('console.log(x)')) ? [proposed] : [];
        };

        // When
        const first = applyStagedAstEdit({
            reason: 'first apply',
            resolveToolCallId: 'resolve_first',
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            files: [targetPath],
            workspaceRoot,
            guard,
            rewriter,
            proposedCount: 1,
            proposedReplacements: [{ path: 'source.ts', count: 1 }],
            proposedChanges: [proposed],
            requestPermission: async (request) => {
                phases.push('approve:first');
                firstApprovalSeen.resolve();
                await releaseFirstApproval.promise;
                return allowPermission(request);
            },
        });
        await firstApprovalSeen.promise;
        const second = applyStagedAstEdit({
            reason: 'second apply',
            resolveToolCallId: 'resolve_second',
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            files: [targetPath],
            workspaceRoot,
            guard,
            rewriter,
            proposedCount: 1,
            proposedReplacements: [{ path: 'source.ts', count: 1 }],
            proposedChanges: [proposed],
            requestPermission: async (request) => {
                phases.push('approve:second');
                return allowPermission(request);
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        const phasesBeforeRelease = [...phases];
        releaseFirstApproval.resolve();
        await Promise.allSettled([first, second]);

        // Then
        expect(phasesBeforeRelease).toEqual(['rewrite', 'approve:first']);
    });

    async function makeWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-ast-apply-'));
        workspaces.push(workspace);
        return workspace;
    }
});

function changeFor(content: Buffer, before: string, after: string, absolutePath: string): NativeAstReplaceChange {
    const byteStart = content.indexOf(Buffer.from(before));
    if (byteStart < 0) throw new TypeError(`missing ${before}`);
    return {
        path: absolutePath,
        before,
        after,
        byteStart,
        byteEnd: byteStart + Buffer.byteLength(before),
        startLine: 1,
        startColumn: byteStart + 1,
        endLine: 1,
        endColumn: byteStart + before.length + 1,
    };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            resolvePromise?.(value);
        },
    };
}
