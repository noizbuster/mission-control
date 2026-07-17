import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeAstReplaceChange } from '../../native/natives-client';
import { type AstRewriteFn, createAstEditToolRegistration } from '../ast-edit';
import { StagedPreviewRegistry } from '../staged-preview-registry';
import { ToolRegistry } from '../tool-registry';
import { createResolveToolRegistration, RESOLVE_TOOL_NAME } from './resolve-tool';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolve approval identity', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('correlates each approval with the invoking resolve tool call', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'resolve-approval-'));
        workspaces.push(workspaceRoot);
        const source = 'console.log(x);\n';
        const absolutePath = join(workspaceRoot, 'src.ts');
        await writeFile(absolutePath, source, 'utf8');
        const change = changeFor(Buffer.from(source), absolutePath);
        const approvalIds: string[] = [];
        const registry = await setupRegistry(
            workspaceRoot,
            () => [change],
            async (request) => {
                approvalIds.push(request.id);
                return allowPermission(request);
            },
        );

        await propose(registry);
        await resolve(registry, 'resolve_call_one');
        await writeFile(absolutePath, source, 'utf8');
        await propose(registry);
        await resolve(registry, 'resolve_call_two');

        expect(approvalIds).toEqual(['permission_resolve_call_one', 'permission_resolve_call_two']);
    });
});

async function setupRegistry(
    workspaceRoot: string,
    rewriter: AstRewriteFn,
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
): Promise<ToolRegistry> {
    const staged = new StagedPreviewRegistry();
    const registry = new ToolRegistry();
    registry.register(
        await createAstEditToolRegistration({ workspaceRoot, registry: staged, rewriter, requestPermission }),
    );
    registry.register(createResolveToolRegistration({ registry: staged }));
    return registry;
}

async function propose(registry: ToolRegistry): Promise<void> {
    const advertisement = requireAdvertisement(registry, 'ast_edit');
    await registry.invoke({
        toolCallId: 'ast_edit_call',
        toolName: 'ast_edit',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['src.ts'],
        }),
    });
}

async function resolve(registry: ToolRegistry, toolCallId: string): Promise<void> {
    const advertisement = requireAdvertisement(registry, RESOLVE_TOOL_NAME);
    await registry.invoke({
        toolCallId,
        toolName: RESOLVE_TOOL_NAME,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ action: 'apply', reason: toolCallId }),
    });
}

function requireAdvertisement(registry: ToolRegistry, toolName: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === toolName);
    if (advertisement === undefined) throw new TypeError(`missing ${toolName} advertisement`);
    return advertisement;
}

function changeFor(content: Buffer, absolutePath: string): NativeAstReplaceChange {
    const before = 'console.log(x)';
    const byteStart = content.indexOf(Buffer.from(before));
    if (byteStart < 0) throw new TypeError('missing console.log fixture');
    return {
        path: absolutePath,
        before,
        after: 'logger.info(x)',
        byteStart,
        byteEnd: byteStart + Buffer.byteLength(before),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: before.length + 1,
    };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'resolve identity test allow' };
}
