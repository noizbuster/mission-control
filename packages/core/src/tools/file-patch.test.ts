import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type FilePatchToolOptions, registerFilePatchTool } from './file-patch.js';
import { ToolRegistry } from './tool-registry.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        const requests: PermissionRequest[] = [];
        const registry = await createRegistry(workspaceRoot, (request) => {
            requests.push(request);
            return denyPermission(request);
        });

        // When
        const result = await invokePatch(registry, patchFor('notes.txt', 'before', 'after'));

        // Then
        expect(result.result.status).toBe('failed');
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('before\n');
        expect(requests).toMatchObject([
            {
                action: 'file.patch',
                permission: {
                    kind: 'patch',
                    patterns: ['notes.txt'],
                    workspaceRoot,
                },
            },
        ]);
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

    it('redacts credential families from real diff output without changing applied files', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        const registry = await createRegistry(workspaceRoot, allowPermission);
        const secrets = filePatchSecretFixtures();
        const payload = filePatchSecretPayload(secrets);

        // When
        const result = await invokePatch(registry, addFilePatchLines('secrets.txt', payload.trimEnd().split('\n')));

        // Then
        expect(result.result.status).toBe('completed');
        expect(await readText(workspaceRoot, 'secrets.txt')).toBe(payload);
        expect(JSON.stringify(result.structuredOutput)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(result.events)).toContain('[REDACTED_CREDENTIAL]');
        for (const secret of secretFragments(secrets)) {
            expect(JSON.stringify(result.structuredOutput)).not.toContain(secret);
            expect(JSON.stringify(result.events)).not.toContain(secret);
        }
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

    it('records partial apply failure without hiding already applied changes', async () => {
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
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: 'file.diff.applied',
                taskId: 'patch_call',
                diffFiles: [expect.objectContaining({ filePath: 'a.txt' })],
            }),
        );
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: 'tool.failed',
                taskId: 'patch_call',
                toolResult: result.result,
            }),
        );
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

function addFilePatchLines(path: string, lines: readonly string[]): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        '',
    ].join('\n');
}

function filePatchSecretFixtures(): readonly string[] {
    return [
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJmaWxlIjoibWlzc2lvbi1jb250cm9sIn0', 'signaturetest'].join('.'),
        ['ghp', 'testFilePatchToken1234567890'].join('_'),
        ['github', 'pat', 'test', 'filepatch1234567890'].join('_'),
        ['AKIA', 'TESTFILEPATCH123'].join(''),
        ['Bearer', ['bearer', 'testFilePatchToken1234567890'].join('_')].join(' '),
        [
            ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
            'file-patch-secret-body',
            ['-----END', 'PRIVATE KEY-----'].join(' '),
        ].join('\n'),
        ['sk', 'proj', 'testFilePatchOpenAI1234567890'].join('-'),
        ['sk', 'ant', 'api03', 'testFilePatchAnthropic1234567890'].join('-'),
        ['AIza', 'FilePatchGoogleToken1234567890'].join(''),
        ['sk', 'or', 'v1', 'testFilePatchCompatible1234567890'].join('-'),
    ];
}

function filePatchSecretPayload(secrets: readonly string[]): string {
    return `${secrets.join('\n')}\n`;
}

function secretFragments(secrets: readonly string[]): readonly string[] {
    return secrets.flatMap((secret) => secret.split('\n')).filter((fragment) => fragment.length > 0);
}

async function readText(workspaceRoot: string, path: string): Promise<string> {
    return readFile(join(workspaceRoot, path), 'utf8');
}
