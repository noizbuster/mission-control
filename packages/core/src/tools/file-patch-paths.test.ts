import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFilePatchTool } from './file-patch.js';
import { ToolRegistry } from './tool-registry.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('file.patch workspace path boundaries', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('rejects symlink escapes before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokePatch(registry, patchFor('link.txt', 'secret', 'changed'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('rejects symlinked parent directories before mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'real'));
        await trackedFile(workspaceRoot, 'real/notes.txt', 'before\n');
        await symlink(join(workspaceRoot, 'real'), join(workspaceRoot, 'linked'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokePatch(registry, patchFor('linked/notes.txt', 'before', 'after'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(workspaceRoot, 'real/notes.txt')).toBe('before\n');
    });

    it('refuses a new file target that becomes a symlink after preflight approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, async (request) => {
            await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'new-link.txt'));
            return allowPermission(request);
        });

        const result = await invokePatch(registry, addFilePatch('new-link.txt', 'changed'));

        expect(result.result.status).toBe('failed');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('refuses an existing target whose parent directory becomes a symlink after approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'safe'));
        await trackedFile(workspaceRoot, 'safe/notes.txt', 'before\n');
        await writeFile(join(outsideRoot, 'notes.txt'), 'before\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, async (request) => {
            await rm(join(workspaceRoot, 'safe'), { recursive: true, force: true });
            await symlink(outsideRoot, join(workspaceRoot, 'safe'));
            return allowPermission(request);
        });

        const result = await invokePatch(registry, patchFor('safe/notes.txt', 'before', 'after'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(outsideRoot, 'notes.txt')).toBe('before\n');
    });

    it('denies generated and reference-repo descendants before approval or mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await mkdir(join(workspaceRoot, 'dist'), { recursive: true });
        await writeFile(join(workspaceRoot, 'dist', 'bundle.txt'), 'before\n', 'utf8');
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request) => {
            permissionRequests.push(request);
            return allowPermission(request);
        });

        const referenceRepo = await invokePatch(
            registry,
            addFilePatch('temp/ref-repos/opencode/AGENTS.md', 'OPENCODE_REFERENCE_AGENT_DIRECTIVE'),
        );
        const generated = await invokePatch(registry, patchFor('dist/bundle.txt', 'before', 'after'));

        expect(referenceRepo.result.error?.message).toContain('workspace_denied');
        expect(generated.result.error?.message).toContain('workspace_denied');
        expect(permissionRequests).toHaveLength(0);
        await expect(
            readFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'AGENTS.md'), 'utf8'),
        ).rejects.toThrow();
        expect(await readText(workspaceRoot, 'dist/bundle.txt')).toBe('before\n');
    });

    it('denies mixed-case generated and reference-repo descendants before approval or mutation', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'Temp', 'ref-repos', 'opencode'), { recursive: true });
        await mkdir(join(workspaceRoot, 'Dist'), { recursive: true });
        await writeFile(join(workspaceRoot, 'Dist', 'bundle.txt'), 'before\n', 'utf8');
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request) => {
            permissionRequests.push(request);
            return allowPermission(request);
        });

        const referenceRepo = await invokePatch(
            registry,
            addFilePatch('Temp/ref-repos/opencode/AGENTS.md', 'MIXED_CASE_REFERENCE_AGENT_DIRECTIVE'),
        );
        const generated = await invokePatch(registry, patchFor('Dist/bundle.txt', 'before', 'after'));

        expect(referenceRepo.result.error?.message).toContain('workspace_denied');
        expect(generated.result.error?.message).toContain('workspace_denied');
        expect(permissionRequests).toHaveLength(0);
        await expect(
            readFile(join(workspaceRoot, 'Temp', 'ref-repos', 'opencode', 'AGENTS.md'), 'utf8'),
        ).rejects.toThrow();
        expect(await readText(workspaceRoot, 'Dist/bundle.txt')).toBe('before\n');
    });

    it('rejects binary patch targets before approval', async () => {
        const workspaceRoot = await createGitWorkspace();
        await writeFile(join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]));
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request) => {
            permissionRequests.push(request);
            return allowPermission(request);
        });

        const result = await invokePatch(registry, patchFor('image.bin', 'before', 'after'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('binary_file');
        expect(permissionRequests).toHaveLength(0);
        expect(await readFile(join(workspaceRoot, 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
    });

    it('rejects symlink chains that escape the workspace', async () => {
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link2.txt'));
        await symlink(join(workspaceRoot, 'link2.txt'), join(workspaceRoot, 'link1.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokePatch(registry, patchFor('link1.txt', 'secret', 'changed'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('rejects a symlink chain through parent directories', async () => {
        const workspaceRoot = await createGitWorkspace();
        await mkdir(join(workspaceRoot, 'real'));
        await trackedFile(workspaceRoot, 'real/notes.txt', 'before\n');
        await symlink(join(workspaceRoot, 'real'), join(workspaceRoot, 'level2'));
        await symlink(join(workspaceRoot, 'level2'), join(workspaceRoot, 'level1'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        const result = await invokePatch(registry, patchFor('level1/notes.txt', 'before', 'after'));

        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(workspaceRoot, 'real/notes.txt')).toBe('before\n');
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-patch-paths-'));
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
    resolvePermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFilePatchTool(registry, { workspaceRoot, requestPermission: resolvePermission });
    return registry;
}

async function trackedFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content, 'utf8');
    await execFileAsync('git', ['add', path], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: workspaceRoot });
}

async function invokePatch(registry: ToolRegistry, patch: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.patch');
    if (advertisement === undefined) {
        throw new TypeError('missing file.patch advertisement');
    }
    return registry.invoke({
        toolCallId: 'patch_call',
        toolName: 'file.patch',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ patch }),
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function patchFor(path: string, before: string, after: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        `-${before}`,
        `+${after}`,
        '',
    ].join('\n');
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

async function readText(workspaceRoot: string, path: string): Promise<string> {
    return readFile(join(workspaceRoot, path), 'utf8');
}
