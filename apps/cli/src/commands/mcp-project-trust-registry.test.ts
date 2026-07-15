import { ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import { allowAllPermission, fakeBroker, noLspServers, toolOptions } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mcpFixturePath, tempRoot } from './run-agent-tool-registry-test-support';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type TrustFixture = {
    readonly configDir: string;
    readonly dataDir: string;
    readonly workspaceRoot: string;
    readonly spawnMarker: string;
};

describe('production MCP registry project trust gate', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('does not spawn a committed project command when interactive workspace trust is undecided', async () => {
        // Given
        const fixture = await createTrustFixture(tempRoots, 'interactive-unknown');
        await writeMaliciousProjectConfig(fixture);

        // When
        const result = await createInteractiveToolRegistry(
            toolOptions(createBufferedChatOutput().output, fixture.workspaceRoot),
            fakeBroker(),
        );

        try {
            // Then
            expect(await pathExists(fixture.spawnMarker)).toBe(false);
            expect(result.registry.advertise().some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
        } finally {
            await result.mcpConnectionManager.disconnectAll();
        }
    });

    it('does not spawn a committed project command when noninteractive workspace trust is denied', async () => {
        // Given
        const fixture = await createTrustFixture(tempRoots, 'noninteractive-denied');
        await new ProjectTrustStore({ dataDir: fixture.dataDir }).setDecision(fixture.workspaceRoot, 'denied');
        await writeMaliciousProjectConfig(fixture);

        // When
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowAllPermission,
            lspServerManagerDeps: noLspServers,
        });

        try {
            // Then
            expect(await pathExists(fixture.spawnMarker)).toBe(false);
            expect(result.registry.advertise().some((tool) => tool.name.startsWith('mcp__'))).toBe(false);
        } finally {
            await result.mcpConnectionManager.disconnectAll();
        }
    });

    it('connects and advertises a project server when the workspace is trusted', async () => {
        // Given
        const fixture = await createTrustFixture(tempRoots, 'noninteractive-trusted');
        await new ProjectTrustStore({ dataDir: fixture.dataDir }).setDecision(fixture.workspaceRoot, 'trusted');
        await writeProjectConfig(fixture.workspaceRoot, {
            trusted_project: {
                type: 'local',
                command: [process.execPath, mcpFixturePath, 'normal'],
                timeoutMs: 5000,
            },
        });

        // When
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowAllPermission,
            lspServerManagerDeps: noLspServers,
        });

        try {
            // Then
            expect(result.registry.advertise().map((tool) => tool.name)).toContain('mcp__trusted_project__echo');
        } finally {
            await result.mcpConnectionManager.disconnectAll();
        }
    });

    it('keeps user-scope MCP active and ignores a colliding untrusted project command', async () => {
        // Given
        const fixture = await createTrustFixture(tempRoots, 'user-unaffected');
        await writeUserConfig(fixture.configDir, {
            shared: {
                type: 'local',
                command: [process.execPath, mcpFixturePath, 'normal'],
                timeoutMs: 5000,
            },
        });
        await writeMaliciousProjectConfig(fixture, 'shared');

        // When
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowAllPermission,
            lspServerManagerDeps: noLspServers,
        });

        try {
            // Then
            expect(await pathExists(fixture.spawnMarker)).toBe(false);
            expect(result.registry.advertise().map((tool) => tool.name)).toContain('mcp__shared__echo');
        } finally {
            await result.mcpConnectionManager.disconnectAll();
        }
    });
});

async function createTrustFixture(tempRoots: string[], label: string): Promise<TrustFixture> {
    const root = await tempRoot(tempRoots, `mctrl-mcp-trust-${label}-`);
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
    return { configDir, dataDir, workspaceRoot, spawnMarker: join(root, 'project-command-spawned') };
}

async function writeMaliciousProjectConfig(fixture: TrustFixture, name = 'committed_project_command'): Promise<void> {
    const source = `require('node:fs').writeFileSync(${JSON.stringify(fixture.spawnMarker)}, 'spawned')`;
    await writeProjectConfig(fixture.workspaceRoot, {
        [name]: { type: 'local', command: [process.execPath, '--eval', source], timeoutMs: 5000 },
    });
}

async function writeProjectConfig(workspaceRoot: string, mcpServers: Readonly<Record<string, unknown>>): Promise<void> {
    await writeFile(join(workspaceRoot, '.mcp.json'), JSON.stringify({ mcpServers }), 'utf8');
}

async function writeUserConfig(configDir: string, mcp: Readonly<Record<string, unknown>>): Promise<void> {
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ mcp }), 'utf8');
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
