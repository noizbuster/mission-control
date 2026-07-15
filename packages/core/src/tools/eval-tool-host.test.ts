import { afterEach, describe, expect, it } from 'vitest';
import { createEvalToolHost } from './eval-tool-host.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('eval tool host workspace containment', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('rejects an external file symlink before returning its bytes', async () => {
        // Given
        const workspaceRoot = await createTempDir('eval-host-workspace-');
        const outsideRoot = await createTempDir('eval-host-outside-');
        await writeFile(join(outsideRoot, 'secret.txt'), 'EXTERNAL_SECRET_BYTES', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'escape.txt'));
        const host = createEvalToolHost(workspaceRoot);

        // When / Then
        await expect(host('read', { path: 'escape.txt' })).rejects.toThrow(/workspace_escape/u);
    });

    it('rejects an external directory symlink before listing its entries', async () => {
        // Given
        const workspaceRoot = await createTempDir('eval-host-workspace-');
        const outsideRoot = await createTempDir('eval-host-outside-');
        await writeFile(join(outsideRoot, 'secret.txt'), 'EXTERNAL_LIST_SECRET', 'utf8');
        await symlink(outsideRoot, join(workspaceRoot, 'escape-dir'));
        const host = createEvalToolHost(workspaceRoot);

        // When / Then
        await expect(host('ls', { path: 'escape-dir' })).rejects.toThrow(/workspace_escape/u);
    });

    it('rejects an external symlink target before searching its contents', async () => {
        // Given
        const workspaceRoot = await createTempDir('eval-host-workspace-');
        const outsideRoot = await createTempDir('eval-host-outside-');
        await mkdir(join(outsideRoot, 'nested'));
        await writeFile(join(outsideRoot, 'nested', 'secret.txt'), 'EXTERNAL_SEARCH_SECRET', 'utf8');
        await symlink(join(outsideRoot, 'nested'), join(workspaceRoot, 'escape-dir'));
        const host = createEvalToolHost(workspaceRoot);

        // When / Then
        await expect(
            host('grep', { pattern: 'EXTERNAL_SEARCH_SECRET', path: 'escape-dir/secret.txt' }),
        ).rejects.toThrow(/workspace_escape/u);
    });

    it('preserves reads through symlinks whose canonical targets stay inside the workspace', async () => {
        // Given
        const workspaceRoot = await createTempDir('eval-host-workspace-');
        await mkdir(join(workspaceRoot, 'data'));
        await writeFile(join(workspaceRoot, 'data', 'safe.txt'), 'SAFE_WORKSPACE_BYTES', 'utf8');
        await symlink(join(workspaceRoot, 'data', 'safe.txt'), join(workspaceRoot, 'safe-link.txt'));
        const host = createEvalToolHost(workspaceRoot);

        // When
        const result = await host('read', { path: 'safe-link.txt' });

        // Then
        expect(result).toBe('SAFE_WORKSPACE_BYTES');
    });

    async function createTempDir(prefix: string): Promise<string> {
        const directory = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(directory);
        return directory;
    }
});
