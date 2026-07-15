import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTrustDecision, ProjectTrustLookup } from '../../trust/project-trust-store';
import { ToolRegistry } from '../tool-registry';
import type { ManagedMcpClient, McpConnectionManagerOptions } from './connection-manager';
import { McpConnectionManager } from './connection-manager';
import { registerNamespacedMcpTools } from './surfacing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MCP live authority lifecycle races', () => {
    let root: string;
    let workspaceRoot: string;
    let userConfigPath: string;
    let projectConfigPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-authority-race-'));
        workspaceRoot = join(root, 'workspace');
        userConfigPath = join(root, 'config.json');
        projectConfigPath = join(workspaceRoot, '.mcp.json');
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(
            projectConfigPath,
            JSON.stringify({ mcpServers: { project_server: { type: 'local', command: ['project-command'] } } }),
            'utf8',
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('rechecks trust after pending approval before dispatching the project handler', async () => {
        // Given
        let decision: ProjectTrustDecision = 'trusted';
        let calls = 0;
        let closes = 0;
        const manager = new McpConnectionManager({
            clientFactory: () =>
                probeClient(
                    () => (calls += 1),
                    () => (closes += 1),
                ),
        });
        const registry = new ToolRegistry();
        await registerNamespacedMcpTools(registry, {
            ...managerOptions(),
            projectTrustStore: trustReader(() => decision),
            mcpConnectionManager: manager,
            requestPermission: async (request) => {
                decision = 'denied';
                return { requestId: request.id, status: 'allow' };
            },
        });

        try {
            // When
            const settlement = await invokeProjectTool(registry);

            // Then
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('workspace_untrusted');
            expect(calls).toBe(0);
            expect(closes).toBe(1);
        } finally {
            await manager.disconnectAll();
        }
    });

    it('closes a connection that finishes connecting after teardown starts', async () => {
        // Given
        const connectStarted = deferred();
        const releaseConnect = deferred();
        let closes = 0;
        const manager = new McpConnectionManager({
            clientFactory: () => ({
                ...probeClient(
                    () => undefined,
                    () => (closes += 1),
                ),
                connect: async () => {
                    connectStarted.resolve();
                    await releaseConnect.promise;
                },
            }),
        });
        const connecting = manager.connectAll(managerOptions());
        await connectStarted.promise;

        // When
        const disconnecting = manager.disconnectAll();
        releaseConnect.resolve();
        await Promise.all([connecting, disconnecting]);

        // Then
        expect(closes).toBe(1);
        expect(manager.getServers()).toEqual([]);
    });

    it('connects an injected reusable manager only once', async () => {
        // Given
        let connections = 0;
        let closes = 0;
        const manager = new McpConnectionManager({
            clientFactory: () => {
                connections += 1;
                return probeClient(
                    () => undefined,
                    () => (closes += 1),
                );
            },
        });

        // When
        await manager.connectAll(managerOptions());
        await manager.connectAll(managerOptions());
        await manager.disconnectAll();

        // Then
        expect(connections).toBe(1);
        expect(closes).toBe(1);
    });

    function managerOptions(): McpConnectionManagerOptions {
        return { workspaceRoot, userConfigPath, projectConfigPath, projectTrustDecision: 'trusted' };
    }
});

function probeClient(onCall: () => void, onClose: () => void): ManagedMcpClient {
    return {
        connect: async () => undefined,
        listTools: async () => [{ name: 'echo', inputSchema: { type: 'object' } }],
        callTool: async () => {
            onCall();
            return 'handled';
        },
        close: async () => onClose(),
    };
}

function trustReader(decision: () => ProjectTrustDecision) {
    return {
        getDecision: async (workspaceRoot: string): Promise<ProjectTrustLookup> => ({
            decision: decision(),
            workspaceRoot,
            filePath: join(workspaceRoot, '.trust', 'projects.json'),
            storeState: 'valid',
        }),
    };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: () => resolvePromise() };
}

async function invokeProjectTool(registry: ToolRegistry) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'mcp__project_server__echo');
    if (advertisement === undefined) throw new Error('missing project MCP tool');
    return registry.invoke({
        toolName: advertisement.name,
        toolCallId: 'approval-race',
        advertisedVersion: advertisement.version,
        argumentsJson: '{}',
    });
}
