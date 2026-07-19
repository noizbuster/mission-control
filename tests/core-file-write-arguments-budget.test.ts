import { FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES } from '@mission-control/core';
import type { AbgNodeSpec, AbgSignal, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { runToolActorNode } from '../packages/core/src/behavior/nodes/tool-actor-node';
import { registerFileWriteTool } from '../packages/core/src/tools/file-write';
import { ToolRegistry } from '../packages/core/src/tools/tool-registry';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaces: string[] = [];

afterEach(async () => {
    await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
    workspaces.length = 0;
});

describe('core file.write argument budget', () => {
    it('fails an oversized ABG tool call before policy, permission, or mutation', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-core-file-write-budget-'));
        workspaces.push(workspaceRoot);
        const targetPath = 'oversized.txt';
        const toolCallId = 'write_oversized_core';
        const invocationPolicyCalls: unknown[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = new ToolRegistry((_advertisement, parsedArguments) => {
            invocationPolicyCalls.push(parsedArguments);
            return undefined;
        });
        await registerFileWriteTool(registry, {
            workspaceRoot,
            requestPermission: (request) => {
                permissionRequests.push(request);
                return { requestId: request.id, status: 'deny', reason: 'read-only test guard' };
            },
        });
        const emptyArgumentsJson = JSON.stringify({ path: targetPath, content: '' });
        const contentBytes =
            FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1 - Buffer.byteLength(emptyArgumentsJson, 'utf8');
        const content = `${'🙂'.repeat(Math.floor(contentBytes / 4))}${'x'.repeat(contentBytes % 4)}`;
        const argumentsValue = { path: targetPath, content };
        const node: AbgNodeSpec = {
            id: 'oversized-file-write',
            kind: 'tool',
            config: { tool: 'file.write', arguments: argumentsValue },
        };
        expect(Buffer.byteLength(JSON.stringify(argumentsValue), 'utf8')).toBe(
            FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1,
        );

        const signals: AbgSignal[] = [];
        for await (const signal of runToolActorNode(node, {
            graphId: 'file-write-budget-graph',
            now: () => '2026-07-18T00:00:00.000Z',
            toolCallId,
            toolRegistry: registry,
        })) {
            signals.push(signal);
        }

        const failure = signals.find((signal) => signal.type === 'failure');
        expect.soft(failure?.error).toEqual({
            code: 'tool_failed',
            toolName: 'file.write',
            message: `file_write_arguments_too_large: maximum ${FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES} bytes`,
        });
        expect.soft(invocationPolicyCalls).toHaveLength(0);
        expect.soft(permissionRequests).toHaveLength(0);
        await expect.soft(access(join(workspaceRoot, targetPath))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
