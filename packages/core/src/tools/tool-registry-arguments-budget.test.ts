import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    createFileWriteToolRegistration,
    FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES,
    registerFileWriteTool,
} from './file-write';
import { ToolRegistry } from './tool-registry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaces: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
    workspaces.length = 0;
});

describe('ToolRegistry file.write argument budget', () => {
    it('accepts exactly 262144 UTF-8 bytes and continues to permission', async () => {
        const workspaceRoot = await createWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = new ToolRegistry();
        const advertisement = await registerReadOnlyFileWrite(registry, workspaceRoot, requests);
        const argumentsJson = fileWriteArgumentsJson(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES);

        const settlement = await registry.invoke({
            toolCallId: 'write_exact_limit',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson,
        });

        expect(Buffer.byteLength(argumentsJson, 'utf8')).toBe(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES);
        expect(settlement.result.error).toEqual({
            code: 'tool_failed',
            message: 'approval_denied: read-only test guard',
            retryable: false,
        });
        expect(requests).toHaveLength(1);
    });

    it('rejects 262145 UTF-8 bytes before parse, invocation policy, or permission', async () => {
        const workspaceRoot = await createWorkspace();
        const requests: PermissionRequest[] = [];
        const policyInputs: unknown[] = [];
        const registry = new ToolRegistry((_advertisement, parsedArguments) => {
            policyInputs.push(parsedArguments);
            return undefined;
        });
        const advertisement = await registerReadOnlyFileWrite(registry, workspaceRoot, requests);
        const argumentsJson = fileWriteArgumentsJson(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1);
        const parse = vi.spyOn(JSON, 'parse');

        const settlement = await registry.invoke({
            toolCallId: 'write_over_limit',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson,
        });

        expect(Buffer.byteLength(argumentsJson, 'utf8')).toBe(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1);
        expect(settlement.result.error).toEqual(argumentLimitError());
        expect(parse).not.toHaveBeenCalled();
        expect(policyInputs).toHaveLength(0);
        expect(requests).toHaveLength(0);
    });

    it('retains the file.write argument budget in a cloned registry', async () => {
        const workspaceRoot = await createWorkspace();
        const requests: PermissionRequest[] = [];
        const parent = new ToolRegistry();
        const advertisement = await registerReadOnlyFileWrite(parent, workspaceRoot, requests);
        const cloned = parent.cloneWithFilter(() => true);

        const settlement = await cloned.invoke({
            toolCallId: 'write_cloned_over_limit',
            toolName: 'file.write',
            advertisedVersion: advertisement.version,
            argumentsJson: fileWriteArgumentsJson(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1),
        });

        expect(settlement.result.error).toEqual(argumentLimitError());
        expect(requests).toHaveLength(0);
    });

    it('does not apply the file.write argument budget to other tools', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register({
            name: 'payload.length',
            description: 'Return payload length.',
            capabilityClasses: ['read'],
            parametersJsonSchema: {
                type: 'object',
                properties: { payload: { type: 'string' } },
                required: ['payload'],
            },
            inputSchema: z.object({ payload: z.string() }),
            outputSchema: z.object({ length: z.number() }),
            outputLimit: { maxModelOutputChars: 64 },
            execute: (input) => ({ length: input.payload.length }),
        });
        const emptyArgumentsJson = JSON.stringify({ payload: '' });
        const argumentsJson = JSON.stringify({
            payload: 'x'.repeat(
                FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1 - Buffer.byteLength(emptyArgumentsJson, 'utf8'),
            ),
        });

        const settlement = await registry.invoke({
            toolCallId: 'other_tool_over_file_write_limit',
            toolName: advertisement.name,
            advertisedVersion: advertisement.version,
            argumentsJson,
        });

        expect(Buffer.byteLength(argumentsJson, 'utf8')).toBe(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1);
        expect(settlement.result.status).toBe('completed');
    });

    it('preserves unknown-tool precedence for oversized arguments', async () => {
        const registry = new ToolRegistry();

        const settlement = await registry.invoke({
            toolCallId: 'unknown_over_limit',
            toolName: 'file.write',
            advertisedVersion: 'missing',
            argumentsJson: 'x'.repeat(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1),
        });

        expect(settlement.result.error).toEqual({
            code: 'tool_failed',
            message: 'unknown tool: file.write',
            retryable: false,
        });
    });

    it('preserves stale-version precedence for oversized arguments', async () => {
        const workspaceRoot = await createWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = new ToolRegistry();
        await registerReadOnlyFileWrite(registry, workspaceRoot, requests);

        const settlement = await registry.invoke({
            toolCallId: 'stale_over_limit',
            toolName: 'file.write',
            advertisedVersion: 'stale',
            argumentsJson: fileWriteArgumentsJson(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES + 1),
        });

        expect(settlement.result.error).toEqual({
            code: 'tool_failed',
            message: 'stale tool call rejected: file.write',
            retryable: false,
        });
        expect(requests).toHaveLength(0);
    });

    it('keeps the internal argument budget out of advertisements and version hashes', async () => {
        const workspaceRoot = await createWorkspace();
        const requests: PermissionRequest[] = [];
        const registration = await createFileWriteToolRegistration({
            workspaceRoot,
            requestPermission: (request) => {
                requests.push(request);
                return { requestId: request.id, status: 'deny', reason: 'read-only test guard' };
            },
        });
        const { maxArgumentsBytes, ...unboundedRegistration } = registration;
        const boundedAdvertisement = new ToolRegistry().register(registration);
        const unboundedAdvertisement = new ToolRegistry().register(unboundedRegistration);

        expect(maxArgumentsBytes).toBe(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES);
        expect(boundedAdvertisement).not.toHaveProperty('maxArgumentsBytes');
        expect(boundedAdvertisement.version).toBe(unboundedAdvertisement.version);
    });
});

async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'mctrl-registry-arguments-budget-'));
    workspaces.push(workspace);
    return workspace;
}

async function registerReadOnlyFileWrite(registry: ToolRegistry, workspaceRoot: string, requests: PermissionRequest[]) {
    return registerFileWriteTool(registry, {
        workspaceRoot,
        requestPermission: (request) => {
            requests.push(request);
            return { requestId: request.id, status: 'deny', reason: 'read-only test guard' };
        },
    });
}

function fileWriteArgumentsJson(size: number): string {
    const emptyArgumentsJson = JSON.stringify({ path: 'bounded.txt', content: '' });
    const contentBytes = size - Buffer.byteLength(emptyArgumentsJson, 'utf8');
    return JSON.stringify({
        path: 'bounded.txt',
        content: `${'🙂'.repeat(Math.floor(contentBytes / 4))}${'x'.repeat(contentBytes % 4)}`,
    });
}

function argumentLimitError() {
    return {
        code: 'tool_failed',
        message: `file_write_arguments_too_large: maximum ${FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES} bytes`,
        retryable: false,
    } as const;
}
