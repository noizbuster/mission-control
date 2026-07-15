import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedMcpServer } from './config.js';
import { type ManagedMcpClient, McpConnectionManager } from './connection-manager.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixturePath = new URL('./fixtures/stdio-fixture-server.mjs', import.meta.url).pathname;
const TEST_TIMEOUT_MS = 15_000;

describe('McpConnectionManager selected workspace cwd', () => {
    let root: string;
    let workspaceRoot: string;
    let userConfigPath: string;
    let projectConfigPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-workspace-cwd-'));
        workspaceRoot = join(root, 'selected-workspace');
        userConfigPath = join(root, 'config', 'config.json');
        projectConfigPath = join(workspaceRoot, '.mcp.json');
        await Promise.all([
            mkdir(workspaceRoot, { recursive: true }),
            mkdir(join(root, 'config'), { recursive: true }),
        ]);
        expect(workspaceRoot).not.toBe(process.cwd());
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it(
        'launches a trusted project stdio server from the selected workspace when launcher cwd differs',
        async () => {
            // Given
            const exitMarker = join(root, 'project-cwd-exited');
            await writeFile(
                projectConfigPath,
                JSON.stringify({ mcpServers: { project_cwd: cwdServer(exitMarker) } }),
                'utf8',
            );
            const manager = new McpConnectionManager();

            try {
                // When
                await manager.connectAll(managerOptions('trusted'));

                // Then
                const server = manager.getServers().find((candidate) => candidate.name === 'project_cwd');
                expect(server?.scope).toBe('project');
                await expect(server?.client.callTool({ name: 'report_cwd' })).resolves.toMatchObject({
                    content: [{ type: 'text', text: workspaceRoot }],
                });
            } finally {
                await manager.disconnectAll();
            }
            await expect(readFile(exitMarker, 'utf8')).resolves.toBe('closed\n');
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'launches a user stdio server from the selected workspace while project trust is unknown',
        async () => {
            // Given
            const exitMarker = join(root, 'user-cwd-exited');
            await writeFile(userConfigPath, JSON.stringify({ mcp: { user_cwd: cwdServer(exitMarker) } }), 'utf8');
            const manager = new McpConnectionManager();

            try {
                // When
                await manager.connectAll(managerOptions('unknown'));

                // Then
                const server = manager.getServers().find((candidate) => candidate.name === 'user_cwd');
                expect(server?.scope).toBe('user');
                await expect(server?.client.callTool({ name: 'report_cwd' })).resolves.toMatchObject({
                    content: [{ type: 'text', text: workspaceRoot }],
                });
            } finally {
                await manager.disconnectAll();
            }
            await expect(readFile(exitMarker, 'utf8')).resolves.toBe('closed\n');
        },
        TEST_TIMEOUT_MS,
    );

    it('keeps remote server resolution unchanged when a selected workspace is present', async () => {
        // Given
        await writeFile(
            userConfigPath,
            JSON.stringify({ mcp: { remote: { type: 'remote', url: 'https://example.test/mcp' } } }),
            'utf8',
        );
        const resolved: ResolvedMcpServer[] = [];
        const client: ManagedMcpClient = {
            connect: vi.fn(async () => undefined),
            listTools: vi.fn(async () => []),
            callTool: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
        };
        const manager = new McpConnectionManager({
            clientFactory: (server) => {
                resolved.push(server);
                return client;
            },
        });

        try {
            // When
            await manager.connectAll(managerOptions('unknown'));

            // Then
            expect(resolved).toEqual([
                {
                    name: 'remote',
                    scope: 'user',
                    type: 'remote',
                    enabled: true,
                    url: 'https://example.test/mcp',
                },
            ]);
        } finally {
            await manager.disconnectAll();
        }
    });

    function managerOptions(projectTrustDecision: 'trusted' | 'unknown') {
        return { workspaceRoot, projectTrustDecision, userConfigPath, projectConfigPath };
    }
});

function cwdServer(exitMarker: string): Readonly<Record<string, unknown>> {
    return {
        type: 'local',
        command: [process.execPath, fixturePath, 'cwd'],
        environment: { MCP_TEST_EXIT_MARKER: exitMarker },
        timeoutMs: 5_000,
    };
}
