import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type BrowserConfigFixture = {
    readonly configDir: string;
    readonly workspaceRoot: string;
};

export async function createBrowserConfigFixture(tempRoots: string[]): Promise<BrowserConfigFixture> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-browser-registry-'));
    tempRoots.push(root);
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    const workspaceRoot = join(root, 'workspace');
    await Promise.all([
        mkdir(configDir, { recursive: true }),
        mkdir(dataDir, { recursive: true }),
        mkdir(workspaceRoot, { recursive: true }),
    ]);
    vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
    vi.stubEnv('MCTRL_DATA_DIR', dataDir);
    return { configDir, workspaceRoot };
}

export async function configureBrowser(
    configDir: string,
    browser: { readonly browserURL: string } | { readonly browserWSEndpoint: string },
): Promise<void> {
    await writeFile(join(configDir, 'config.json'), `${JSON.stringify({ browser })}\n`, 'utf8');
}

export async function allowPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}
