import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type FileWriteToolOptions, registerFileWriteTool } from './file-write.js';
import { ToolRegistry } from './tool-registry.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('file.write tool', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('creates a new workspace file after approval with create diff events', async () => {
        const workspaceRoot = await createGitWorkspace();
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'notes.txt',
            content: 'created\n',
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('created\n');
        expect(result.structuredOutput).toMatchObject({
            kind: 'file_write',
            operation: 'created',
            appliedFiles: ['notes.txt'],
            createdParentDirectories: [],
        });
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['file.diff.proposed', 'file.diff.applied', 'tool.completed']),
        );
        expect(result.events.find((event) => event.type === 'file.diff.applied')?.diffFiles).toMatchObject([
            { filePath: 'notes.txt', changeKind: 'added' },
        ]);
    });

    it('replaces an existing tracked file after approval with replace diff events', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'notes.txt',
            content: 'after\n',
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('after\n');
        expect(result.structuredOutput).toMatchObject({
            operation: 'replaced',
            appliedFiles: ['notes.txt'],
        });
        expect(result.events.find((event) => event.type === 'file.diff.applied')?.diffFiles).toMatchObject([
            { filePath: 'notes.txt', changeKind: 'modified' },
        ]);
    });

    it('fails when the parent directory is missing and createParents is not enabled', async () => {
        const workspaceRoot = await createGitWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const result = await invokeWrite(registry, {
            path: 'nested/notes.txt',
            content: 'created\n',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('write_failed');
        expect(result.result.error?.message).toContain('parent directory does not exist');
        expect(requests).toHaveLength(0);
        await expect(readFile(join(workspaceRoot, 'nested', 'notes.txt'), 'utf8')).rejects.toThrow();
    });

    it('creates missing parent directories only when explicitly requested', async () => {
        const workspaceRoot = await createGitWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const result = await invokeWrite(registry, {
            path: 'nested/deeper/notes.txt',
            content: 'created\n',
            createParents: true,
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'nested/deeper/notes.txt')).toBe('created\n');
        expect(result.structuredOutput).toMatchObject({
            operation: 'created',
            createdParentDirectories: ['nested', 'nested/deeper'],
        });
        expect(requests).toMatchObject([
            {
                action: 'file.write',
                permission: {
                    kind: 'write',
                    patterns: ['nested/deeper/notes.txt'],
                    workspaceRoot,
                },
            },
        ]);
    });

    it('rejects denied workspace paths before approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const result = await invokeWrite(registry, {
            path: 'dist/generated.txt',
            content: 'generated\n',
            createParents: true,
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_denied');
        expect(requests).toHaveLength(0);
    });

    it('rejects binary-looking content before approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const result = await invokeWrite(registry, {
            path: 'binary.bin',
            content: '\u0000\u0001\u0002',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('binary_file');
        expect(requests).toHaveLength(0);
        await expect(readFile(join(workspaceRoot, 'binary.bin'))).rejects.toThrow();
    });

    it('refuses dirty tracked replacement targets without an explicit dirty override', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        await writeFile(join(workspaceRoot, 'notes.txt'), 'dirty\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'notes.txt',
            content: 'after\n',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('dirty_target');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('dirty\n');
    });

    it('rejects symlink targets before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'link.txt',
            content: 'changed\n',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('rejects symlink targets even when the target stays inside the workspace', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'target.txt', 'before\n');
        await symlink(join(workspaceRoot, 'target.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'link.txt',
            content: 'after\n',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(workspaceRoot, 'target.txt')).toBe('before\n');
    });

    it('rejects symlinked parent directories before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'real'));
        await trackedFile(workspaceRoot, 'real/notes.txt', 'before\n');
        await symlink(join(workspaceRoot, 'real'), join(workspaceRoot, 'linked'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeWrite(registry, {
            path: 'linked/notes.txt',
            content: 'after\n',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(workspaceRoot, 'real/notes.txt')).toBe('before\n');
    });

    it('leaves files unchanged when approval is denied', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return denyPermission(request);
        });

        const result = await invokeWrite(registry, {
            path: 'notes.txt',
            content: 'after\n',
        });

        expect(result.result.status).toBe('failed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before\n');
        expect(requests).toMatchObject([
            {
                action: 'file.write',
                permission: {
                    kind: 'write',
                    patterns: ['notes.txt'],
                    workspaceRoot,
                },
            },
        ]);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-write-'));
        workspaces.push(workspace);
        return workspace;
    }

    async function createGitWorkspace(): Promise<string> {
        const workspace = await createWorkspace();
        await execFileAsync('git', ['init'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspace });
        return workspace;
    }
});

async function createRegistry(
    workspaceRoot: string,
    requestPermission: FileWriteToolOptions['requestPermission'],
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFileWriteTool(registry, { workspaceRoot, requestPermission });
    return registry;
}

async function trackedFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content, 'utf8');
    await execFileAsync('git', ['add', path], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: workspaceRoot });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

async function invokeWrite(
    registry: ToolRegistry,
    input: {
        readonly path: string;
        readonly content: string;
        readonly createParents?: boolean;
    },
) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.write');
    if (advertisement === undefined) {
        throw new TypeError('missing file.write advertisement');
    }
    return registry.invoke({
        toolCallId: 'write_call',
        toolName: 'file.write',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

async function readText(workspaceRoot: string, path: string): Promise<string> {
    return readFile(join(workspaceRoot, path), 'utf8');
}
