import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type FileEditToolOptions, registerFileEditTool } from './file-edit.js';
import { fileEditInputSchema } from './file-edit-schemas.js';
import { ToolRegistry } from './tool-registry.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('file.edit tool', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('replaces a unique exact match and records replayable diff events', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before unique after\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'unique',
            newText: 'changed',
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before changed after\n');
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['file.diff.proposed', 'file.diff.applied', 'tool.completed']),
        );
        expect(result.structuredOutput).toMatchObject({
            kind: 'file_edit',
            appliedFiles: ['notes.txt'],
            occurrencesReplaced: 1,
        });
    });

    it('rejects ambiguous selector input before approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before unique after\n');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const parsed = fileEditInputSchema.safeParse({
            path: 'notes.txt',
            oldText: 'unique',
            newText: 'changed',
            occurrence: 1,
            replaceAll: false,
        });
        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'unique',
            newText: 'changed',
            occurrence: 1,
            replaceAll: false,
        });

        expect(parsed.success).toBe(false);
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.code).toBe('schema_invalid');
        expect(requests).toHaveLength(0);
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before unique after\n');
    });

    it('fails when no exact match exists', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'missing',
            newText: 'after',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('edit_not_found');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before\n');
    });

    it('fails on multiple matches unless the selection is explicit', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'repeat repeat\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'repeat',
            newText: 'done',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('edit_not_unique');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('repeat repeat\n');
    });

    it('replaces only the requested occurrence when one is selected', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'repeat repeat repeat\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'repeat',
            newText: 'done',
            occurrence: 2,
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('repeat done repeat\n');
        expect(result.structuredOutput).toMatchObject({
            occurrencesReplaced: 1,
        });
    });

    it('replaces all exact matches when replaceAll is true', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'repeat repeat repeat\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'repeat',
            newText: 'done',
            replaceAll: true,
        });

        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('done done done\n');
        expect(result.structuredOutput).toMatchObject({
            occurrencesReplaced: 3,
        });
    });

    it('rejects no-op edits before mutation and diff application', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before unique after\n');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const parsed = fileEditInputSchema.safeParse({
            path: 'notes.txt',
            oldText: 'unique',
            newText: 'unique',
        });
        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'unique',
            newText: 'unique',
        });

        expect(parsed.success).toBe(false);
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.code).toBe('schema_invalid');
        expect(result.result.error?.message).toContain('oldText and newText must differ');
        expect(result.events.map((event) => event.type)).not.toContain('file.diff.applied');
        expect(requests).toHaveLength(0);
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before unique after\n');
    });

    it('refuses dirty tracked targets', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        await writeFile(join(workspaceRoot, 'notes.txt'), 'dirty\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'dirty',
            newText: 'after',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('dirty_target');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('dirty\n');
    });

    it('rejects symlink escapes before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'link.txt',
            oldText: 'secret',
            newText: 'changed',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readFile(join(outsideRoot, 'secret.txt'), 'utf8')).toBe('secret\n');
    });

    it('rejects symlinked parent directories before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'real'));
        await trackedFile(workspaceRoot, 'real/notes.txt', 'before\n');
        await symlink(join(workspaceRoot, 'real'), join(workspaceRoot, 'linked'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokeEdit(registry, {
            path: 'linked/notes.txt',
            oldText: 'before',
            newText: 'after',
        });

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(workspaceRoot, 'real/notes.txt')).toBe('before\n');
    });

    it('denies generated and reference-repo descendants before approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'dist'), { recursive: true });
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(join(workspaceRoot, 'dist', 'bundle.txt'), 'before\n', 'utf8');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return allowPermission(request);
        });

        const generated = await invokeEdit(registry, {
            path: 'dist/bundle.txt',
            oldText: 'before',
            newText: 'after',
        });
        const referenceRepo = await invokeEdit(registry, {
            path: 'temp/ref-repos/opencode/README.md',
            oldText: 'before',
            newText: 'after',
        });

        expect(generated.result.error?.message).toContain('workspace_denied');
        expect(referenceRepo.result.error?.message).toContain('workspace_denied');
        expect(requests).toHaveLength(0);
        expect(await readText(workspaceRoot, 'dist/bundle.txt')).toBe('before\n');
    });

    it('leaves files unchanged when approval is denied', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request: PermissionRequest) => {
            requests.push(request);
            return denyPermission(request);
        });

        const result = await invokeEdit(registry, {
            path: 'notes.txt',
            oldText: 'before',
            newText: 'after',
        });

        expect(result.result.status).toBe('failed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before\n');
        expect(requests).toMatchObject([
            {
                action: 'file.edit',
                permission: {
                    kind: 'edit',
                    patterns: ['notes.txt'],
                    workspaceRoot,
                },
            },
        ]);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-edit-'));
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
    requestPermission: FileEditToolOptions['requestPermission'],
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFileEditTool(registry, { workspaceRoot, requestPermission });
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

async function invokeEdit(
    registry: ToolRegistry,
    input: {
        readonly path: string;
        readonly oldText: string;
        readonly newText: string;
        readonly occurrence?: number;
        readonly replaceAll?: boolean;
    },
) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.edit');
    if (advertisement === undefined) {
        throw new TypeError('missing file.edit advertisement');
    }
    return registry.invoke({
        toolCallId: 'edit_call',
        toolName: 'file.edit',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

async function readText(workspaceRoot: string, path: string): Promise<string> {
    return readFile(join(workspaceRoot, path), 'utf8');
}
