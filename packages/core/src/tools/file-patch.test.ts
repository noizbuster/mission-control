import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type FilePatchToolOptions, registerFilePatchTool } from './file-patch.js';
import { ToolRegistry } from './tool-registry.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('file.patch tool', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('leaves files unchanged when approval is denied', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const registry = await createRegistry(workspaceRoot, denyPermission);

        // When
        const result = await invokePatch(registry, patchFor('notes.txt', 'before', 'after'));

        // Then
        expect(result.result.status).toBe('failed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before\n');
    });

    it('applies approved patches and records replayable diff events', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        // When
        const result = await invokePatch(registry, patchFor('notes.txt', 'before', 'after'));

        // Then
        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('after\n');
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['file.diff.proposed', 'file.diff.applied', 'tool.completed']),
        );
        expect(result.events.find((event) => event.type === 'file.diff.applied')?.diffFiles).toMatchObject([
            { filePath: 'notes.txt', changeKind: 'modified' },
        ]);
    });

    it('redacts token-like diff line content without changing applied files', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);
        const secret = ['sk', 'task14_token_123'].join('-');

        // When
        const result = await invokePatch(registry, patchFor('notes.txt', 'before', secret));

        // Then
        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe(`${secret}\n`);
        expect(JSON.stringify(result.structuredOutput)).not.toContain(secret);
        expect(JSON.stringify(result.events)).not.toContain(secret);
        expect(
            result.events.find((event) => event.type === 'file.diff.applied')?.diffFiles?.[0]?.hunks[0]?.lines,
        ).toContainEqual({
            kind: 'added',
            content: '[REDACTED_CREDENTIAL]',
            redacted: true,
        });
    });

    it('refuses dirty tracked target paths even when model arguments request dirty writes', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        await writeFile(join(workspaceRoot, 'notes.txt'), 'dirty\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        // When
        const refused = await invokePatch(registry, patchFor('notes.txt', 'dirty', 'after'));
        const modelBypass = await invokePatch(registry, patchFor('notes.txt', 'dirty', 'after'), { allowDirty: true });

        // Then
        expect(refused.result.status).toBe('failed');
        expect(refused.result.error?.message).toContain('dirty_target');
        expect(modelBypass.result.status).toBe('failed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('dirty\n');
    });

    it('allows dirty tracked target paths only through explicit registration authorization', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        await writeFile(join(workspaceRoot, 'notes.txt'), 'dirty\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, allowPermission, { allowDirtyPaths: ['notes.txt'] });

        // When
        const allowed = await invokePatch(registry, patchFor('notes.txt', 'dirty', 'after'));

        // Then
        expect(allowed.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('after\n');
    });

    it('rejects symlink escapes before mutation', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot, allowPermission);

        // When
        const result = await invokePatch(registry, patchFor('link.txt', 'secret', 'changed'));

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('workspace_escape');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('allows approved patches to create ignored files inside the workspace', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, '.gitignore', 'ignored.txt\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        // When
        const result = await invokePatch(registry, addFilePatch('ignored.txt', 'generated'));

        // Then
        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'ignored.txt')).toBe('generated\n');
    });

    it('refuses a new file target that becomes a symlink after preflight approval', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        const registry = await createRegistry(workspaceRoot, async (request) => {
            await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'new-link.txt'));
            return allowPermission(request);
        });

        // When
        const result = await invokePatch(registry, addFilePatch('new-link.txt', 'changed'));

        // Then
        expect(result.result.status).toBe('failed');
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('reports partial failure without hiding already applied changes', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'a.txt', 'one\n');
        await trackedFile(workspaceRoot, 'b.txt', 'two\n');
        const registry = await createRegistry(workspaceRoot, allowPermission);

        // When
        const result = await invokePatch(
            registry,
            `${patchFor('a.txt', 'one', 'ONE')}\n${patchFor('b.txt', 'missing', 'TWO')}`,
        );

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('partial_failed');
        expect(result.result.error?.message).toContain('a.txt');
        expect(result.result.error?.message).toContain('b.txt');
        expect(await readText(workspaceRoot, 'a.txt')).toBe('ONE\n');
        expect(await readText(workspaceRoot, 'b.txt')).toBe('two\n');
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-patch-'));
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
    resolvePermission: FilePatchToolOptions['requestPermission'],
    options: Pick<FilePatchToolOptions, 'allowDirtyPaths'> = {},
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFilePatchTool(registry, { workspaceRoot, requestPermission: resolvePermission, ...options });
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

async function invokePatch(registry: ToolRegistry, patch: string, options: { readonly allowDirty?: boolean } = {}) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.patch');
    if (advertisement === undefined) {
        throw new TypeError('missing file.patch advertisement');
    }
    return registry.invoke({
        toolCallId: 'patch_call',
        toolName: 'file.patch',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ patch, ...options }),
    });
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
