import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNativesClient } from '../native/natives-client';
import { registerFileEditTool } from './file-edit';
import { registerFsCacheInvalidator } from './file-mutation';
import { registerFilePatchTool } from './file-patch';
import { registerFileWriteTool } from './file-write';
import { createWorkspaceGuard } from './read-tools-paths';
import { searchRepoText } from './read-tools-search';
import { ToolRegistry } from './tool-registry';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const addonRoot = process.cwd();
const defaultAddonPath = join(addonRoot, 'native', 'natives', 'index.node');
// The fs_cache module only exists in addon builds that include task 9; the
// TOCTOU test asserts real behavior when present and skips otherwise.
const addonBuilt = existsSync(defaultAddonPath);

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

describe('fs cache invalidation hook', () => {
    const workspaces: string[] = [];
    let invalidateCalls = 0;

    beforeEach(() => {
        invalidateCalls = 0;
        registerFsCacheInvalidator(() => {
            invalidateCalls += 1;
        });
    });

    afterEach(async () => {
        registerFsCacheInvalidator(undefined);
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('fires the invalidator after a successful file.write', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'target.txt', 'before\n');
        const registry = await createWriteRegistry(workspaceRoot);

        await invokeWrite(registry, { path: 'target.txt', content: 'after\n' });

        expect(invalidateCalls).toBe(1);
    });

    it('fires the invalidator after a successful file.edit', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'target.txt', 'before unique after\n');
        const registry = await createEditRegistry(workspaceRoot);

        await invokeEdit(registry, { path: 'target.txt', oldText: 'unique', newText: 'changed' });

        expect(invalidateCalls).toBe(1);
    });

    it('fires the invalidator after a successful file.patch', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'target.txt', 'line one\nline two\n');
        const registry = await createPatchRegistry(workspaceRoot);

        await invokePatch(registry, {
            patch: [
                'diff --git a/target.txt b/target.txt',
                '--- a/target.txt',
                '+++ b/target.txt',
                '@@ -1,2 +1,2 @@',
                ' line one',
                '-line two',
                '+line edited',
                '',
            ].join('\n'),
        });

        expect(invalidateCalls).toBe(1);
    });

    it('does NOT fire the invalidator when approval is denied', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'target.txt', 'before unique after\n');
        const registry = new ToolRegistry();
        await registerFileEditTool(registry, {
            workspaceRoot,
            requestPermission: (request) => ({ requestId: request.id, status: 'deny', reason: 'no' }),
        });

        const settlement = await invokeEdit(registry, {
            path: 'target.txt',
            oldText: 'unique',
            newText: 'changed',
        });

        expect(settlement.result.status).toBe('failed');
        expect(invalidateCalls).toBe(0);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-fs-cache-'));
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

// End-to-end TOCTOU: read (grep) a file, mutate it via file.edit (which fires
// the registered invalidator), then grep again and assert the new content —
// never the stale pre-mutation content. Exercises the real native cache when
// the addon is built; skipped otherwise.
describe('fs cache TOCTOU after file.edit (native)', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        registerFsCacheInvalidator(undefined);
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it.skipIf(!addonBuilt)('serves fresh content after file.edit invalidates the cache', async () => {
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'src.txt', 'VERSION_ONE marker\n');
        const natives = createNativesClient({ addonPath: defaultAddonPath, onWarning: () => {} });
        // Register the real invalidator so file.edit clears the cache.
        registerFsCacheInvalidator(() => natives.invalidateFsScanCache());
        const guard = await createWorkspaceGuard(workspaceRoot);
        const registry = await createEditRegistry(workspaceRoot);
        const absPath = join(workspaceRoot, 'src.txt');

        // Prime the cache with the original content.
        const beforeHits = await searchRepoText(
            guard,
            { pattern: 'VERSION_ONE', path: 'src.txt' },
            { maxMatches: 50, maxLineChars: 200 },
            natives,
        );
        expect(beforeHits.matches.length).toBe(1);
        expect(beforeHits.matches[0]?.text).toContain('VERSION_ONE');

        // Mutate the file through the real mutation queue (fires invalidator).
        const settlement = await invokeEdit(registry, {
            path: 'src.txt',
            oldText: 'VERSION_ONE',
            newText: 'VERSION_TWO',
        });
        expect(settlement.result.status).toBe('completed');

        // The adversarial assertion: the post-mutation grep MUST see the new
        // content and NOT the stale VERSION_ONE entry the cache held.
        const afterNew = await searchRepoText(
            guard,
            { pattern: 'VERSION_TWO', path: 'src.txt' },
            { maxMatches: 50, maxLineChars: 200 },
            natives,
        );
        expect(afterNew.matches.length).toBe(1);
        expect(afterNew.matches[0]?.text).toContain('VERSION_TWO');

        const afterOld = await searchRepoText(
            guard,
            { pattern: 'VERSION_ONE', path: 'src.txt' },
            { maxMatches: 50, maxLineChars: 200 },
            natives,
        );
        expect(afterOld.matches.length).toBe(0);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-fs-cache-toctou-'));
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

async function trackedFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content, 'utf8');
    await execFileAsync('git', ['add', path], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: workspaceRoot });
}

async function createEditRegistry(workspaceRoot: string): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFileEditTool(registry, { workspaceRoot, requestPermission: allowPermission });
    return registry;
}

async function createWriteRegistry(workspaceRoot: string): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFileWriteTool(registry, { workspaceRoot, requestPermission: allowPermission });
    return registry;
}

async function createPatchRegistry(workspaceRoot: string): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFilePatchTool(registry, { workspaceRoot, requestPermission: allowPermission });
    return registry;
}

async function invokeEdit(
    registry: ToolRegistry,
    input: { readonly path: string; readonly oldText: string; readonly newText: string },
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

async function invokeWrite(registry: ToolRegistry, input: { readonly path: string; readonly content: string }) {
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

async function invokePatch(registry: ToolRegistry, input: { readonly patch: string }) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'file.patch');
    if (advertisement === undefined) {
        throw new TypeError('missing file.patch advertisement');
    }
    return registry.invoke({
        toolCallId: 'patch_call',
        toolName: 'file.patch',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}
