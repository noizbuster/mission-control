import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceRoot } from './run-agent.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
}

describe('resolveWorkspaceRoot', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('uses the explicit --workspace path when provided and resolves to absolute', async () => {
        const dir = await makeTempDir('mctrl-workspace-explicit-');

        const result = resolveWorkspaceRoot(dir);

        expect(result).toBe(dir);
        await rm(dir, { recursive: true, force: true });
    });

    it('throws when the explicit --workspace path does not exist', () => {
        expect(() => resolveWorkspaceRoot('/nonexistent/mctrl-workspace-path')).toThrow(
            '--workspace path does not exist or is not a directory',
        );
    });

    it('throws when the explicit --workspace path is a file, not a directory', async () => {
        const dir = await makeTempDir('mctrl-workspace-file-');
        const filePath = join(dir, 'not-a-dir.txt');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(filePath, 'nope', 'utf8');

        expect(() => resolveWorkspaceRoot(filePath)).toThrow(
            '--workspace path does not exist or is not a directory',
        );
        await rm(dir, { recursive: true, force: true });
    });

    it('falls back to MCTRL_WORKSPACE when --workspace is not provided', async () => {
        const dir = await makeTempDir('mctrl-workspace-env-');
        vi.stubEnv('MCTRL_WORKSPACE', dir);

        const result = resolveWorkspaceRoot(undefined);

        expect(result).toBe(dir);
        await rm(dir, { recursive: true, force: true });
    });

    it('throws when MCTRL_WORKSPACE points at a missing directory', () => {
        vi.stubEnv('MCTRL_WORKSPACE', '/nonexistent/mctrl-env-workspace');

        expect(() => resolveWorkspaceRoot(undefined)).toThrow(
            'MCTRL_WORKSPACE path does not exist or is not a directory',
        );
    });

    it('prefers --workspace over MCTRL_WORKSPACE when both are set', async () => {
        const flagDir = await makeTempDir('mctrl-workspace-flag-');
        const envDir = await makeTempDir('mctrl-workspace-env2-');
        vi.stubEnv('MCTRL_WORKSPACE', envDir);

        const result = resolveWorkspaceRoot(flagDir);

        expect(result).toBe(flagDir);
        await rm(flagDir, { recursive: true, force: true });
        await rm(envDir, { recursive: true, force: true });
    });

    it('ignores empty MCTRL_WORKSPACE and falls back to detectWorkspaceRoot', () => {
        vi.stubEnv('MCTRL_WORKSPACE', '');

        const result = resolveWorkspaceRoot(undefined);

        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });
});
