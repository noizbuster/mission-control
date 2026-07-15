import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTrustDecision, ProjectTrustLookup } from '../../trust/project-trust-store.js';
import { ToolRegistry } from '../tool-registry.js';
import type { ResolvedMcpServer } from './config.js';
import {
    type ManagedMcpClient,
    McpConnectionManager,
    type McpConnectionManagerDependencies,
} from './connection-manager.js';
import { registerNamespacedMcpTools } from './surfacing.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TrustStoreReader = {
    getDecision(workspaceRoot: string): Promise<ProjectTrustLookup>;
};

describe('MCP project config workspace trust gate', () => {
    let root: string;
    let workspaceRoot: string;
    let userConfigPath: string;
    let projectConfigPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-project-trust-'));
        workspaceRoot = join(root, 'workspace');
        userConfigPath = join(root, 'config.json');
        projectConfigPath = join(workspaceRoot, '.mcp.json');
        await mkdir(workspaceRoot, { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('creates zero project connectors when workspace trust is %s', async (decision) => {
        // Given
        await writeProjectServers(projectConfigPath, {
            committed_command: { type: 'local', command: ['malicious-project-command'] },
        });
        const created: ResolvedMcpServer[] = [];
        const manager = recordingManager(created);

        // When
        await registerNamespacedMcpTools(new ToolRegistry(), {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: trustStore(decision),
            mcpConnectionManager: manager,
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
        });

        // Then
        expect(created).toEqual([]);
    });

    it('treats a failed trust lookup as untrusted before connector creation', async () => {
        // Given
        await writeProjectServers(projectConfigPath, {
            committed_command: { type: 'local', command: ['malicious-project-command'] },
        });
        const created: ResolvedMcpServer[] = [];
        let lookupCount = 0;
        const failedTrustStore: TrustStoreReader = {
            getDecision: async () => {
                lookupCount += 1;
                throw new Error('trust store unavailable');
            },
        };

        // When
        await registerNamespacedMcpTools(new ToolRegistry(), {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: failedTrustStore,
            mcpConnectionManager: recordingManager(created),
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
        });

        // Then
        expect(lookupCount).toBe(1);
        expect(created).toEqual([]);
    });

    it('creates a project connector when the canonical trust decision is trusted', async () => {
        // Given
        await writeProjectServers(projectConfigPath, {
            trusted_project: { type: 'local', command: ['trusted-project-command'] },
        });
        const created: ResolvedMcpServer[] = [];

        // When
        await registerNamespacedMcpTools(new ToolRegistry(), {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: trustStore('trusted'),
            mcpConnectionManager: recordingManager(created),
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
        });

        // Then
        expect(created.map((server) => server.scope)).toEqual(['project']);
    });

    it('keeps user scope active when an untrusted project defines the same server name', async () => {
        // Given
        await writeFile(
            userConfigPath,
            JSON.stringify({ mcp: { shared: { type: 'local', command: ['user-command'] } } }),
            'utf8',
        );
        await writeProjectServers(projectConfigPath, {
            shared: { type: 'local', command: ['malicious-project-command'] },
        });
        const created: ResolvedMcpServer[] = [];

        // When
        await registerNamespacedMcpTools(new ToolRegistry(), {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: trustStore('unknown'),
            mcpConnectionManager: recordingManager(created),
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
        });

        // Then
        expect(created.map((server) => ({ name: server.name, scope: server.scope }))).toEqual([
            { name: 'shared', scope: 'user' },
        ]);
    });

    it('does not read malformed project config before trust', async () => {
        // Given
        await writeFile(projectConfigPath, '{ malformed project config', 'utf8');
        const manager = recordingManager([]);

        // When
        await registerNamespacedMcpTools(new ToolRegistry(), {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: trustStore('unknown'),
            mcpConnectionManager: manager,
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
        });

        // Then
        expect(manager.getWarnings()).toEqual([]);
    });
});

function recordingManager(created: ResolvedMcpServer[]): McpConnectionManager {
    const dependencies: McpConnectionManagerDependencies = {
        clientFactory: (server) => {
            created.push(server);
            return connectedClient();
        },
    };
    return new McpConnectionManager(dependencies);
}

function connectedClient(): ManagedMcpClient {
    return {
        connect: async () => undefined,
        listTools: async () => [],
        callTool: async () => undefined,
        close: async () => undefined,
    };
}

function trustStore(decision: ProjectTrustDecision): TrustStoreReader {
    return {
        getDecision: async (rootPath) => ({
            decision,
            workspaceRoot: rootPath,
            filePath: join(rootPath, '.trust', 'projects.json'),
            storeState: 'valid',
        }),
    };
}

async function writeProjectServers(path: string, mcpServers: Readonly<Record<string, unknown>>): Promise<void> {
    await writeFile(path, JSON.stringify({ mcpServers }), 'utf8');
}
