import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTrustDecision, ProjectTrustLookup } from '../../trust/project-trust-store';
import { ToolRegistry } from '../tool-registry';
import type { ManagedMcpClient } from './connection-manager';
import { McpConnectionManager } from './connection-manager';
import { registerNamespacedMcpTools } from './surfacing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ClientProbe = {
    readonly client: ManagedMcpClient;
    readonly callCount: () => number;
    readonly closeCount: () => number;
};

type TrustController = {
    readonly reader: { getDecision(workspaceRoot: string): Promise<ProjectTrustLookup> };
    readonly setDecision: (decision: ProjectTrustDecision) => void;
    readonly failLookup: () => void;
};

describe('project MCP live trust revocation', () => {
    let root: string;
    let workspaceRoot: string;
    let userConfigPath: string;
    let projectConfigPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-live-trust-'));
        workspaceRoot = join(root, 'workspace');
        userConfigPath = join(root, 'config.json');
        projectConfigPath = join(workspaceRoot, '.mcp.json');
        await mkdir(workspaceRoot, { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('invokes a connected project tool while canonical trust remains trusted', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { project: ['project_server'] });

        try {
            // When
            const settlement = await invoke(setup.registry, 'mcp__project_server__echo', 'trusted-call');

            // Then
            expect(settlement.result.status).toBe('completed');
            expect(setup.probes.get('project_server')?.callCount()).toBe(1);
            expect(setup.permissionCount()).toBe(1);
        } finally {
            await setup.manager.disconnectAll();
        }
    });

    it('rejects the next project invocation before its handler and closes the project connection after revocation', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { project: ['project_server'] });
        trust.setDecision('denied');

        try {
            // When
            const settlement = await invoke(setup.registry, 'mcp__project_server__echo', 'revoked-call');

            // Then
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('workspace_untrusted');
            expect(setup.probes.get('project_server')?.callCount()).toBe(0);
            expect(setup.probes.get('project_server')?.closeCount()).toBe(1);
            expect(setup.permissionCount()).toBe(0);
            expect(setup.manager.getServers()).toEqual([]);
        } finally {
            await setup.manager.disconnectAll();
        }
    });

    it('does not reuse a quarantined project connection on subsequent calls', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { project: ['project_server'] });
        trust.setDecision('denied');
        await invoke(setup.registry, 'mcp__project_server__echo', 'quarantine-call');
        trust.setDecision('trusted');

        try {
            // When
            const settlement = await invoke(setup.registry, 'mcp__project_server__echo', 'stale-call');

            // Then
            expect(settlement.result.status).toBe('failed');
            expect(setup.probes.get('project_server')?.callCount()).toBe(0);
            expect(setup.probes.get('project_server')?.closeCount()).toBe(1);
        } finally {
            await setup.manager.disconnectAll();
        }
    });

    it('keeps user-scope tools usable when project scope is quarantined', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { user: ['user_server'], project: ['project_server'] });
        trust.setDecision('unknown');
        await invoke(setup.registry, 'mcp__project_server__echo', 'revoke-project');

        try {
            // When
            const settlement = await invoke(setup.registry, 'mcp__user_server__echo', 'user-call');

            // Then
            expect(settlement.result.status).toBe('completed');
            expect(setup.probes.get('user_server')?.callCount()).toBe(1);
            expect(setup.probes.get('user_server')?.closeCount()).toBe(0);
            expect(setup.manager.getServers().map((server) => server.scope)).toEqual(['user']);
        } finally {
            await setup.manager.disconnectAll();
        }
    });

    it('fails closed and quarantines project scope when the live trust lookup errors', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { project: ['project_server'] });
        trust.failLookup();

        try {
            // When
            const settlement = await invoke(setup.registry, 'mcp__project_server__echo', 'lookup-error');

            // Then
            expect(settlement.result.status).toBe('failed');
            expect(setup.probes.get('project_server')?.callCount()).toBe(0);
            expect(setup.probes.get('project_server')?.closeCount()).toBe(1);
            expect(setup.permissionCount()).toBe(0);
        } finally {
            await setup.manager.disconnectAll();
        }
    });

    it('closes each scoped connection exactly once across repeated quarantine and teardown', async () => {
        // Given
        const trust = trustController();
        const setup = await connectServers(trust, { user: ['user_server'], project: ['project_server'] });

        // When
        await setup.manager.disconnectScope('project');
        await setup.manager.disconnectScope('project');
        await setup.manager.disconnectAll();
        await setup.manager.disconnectAll();

        // Then
        expect(setup.probes.get('project_server')?.closeCount()).toBe(1);
        expect(setup.probes.get('user_server')?.closeCount()).toBe(1);
    });

    async function connectServers(
        trust: TrustController,
        names: { readonly user?: readonly string[]; readonly project?: readonly string[] },
    ): Promise<{
        readonly registry: ToolRegistry;
        readonly manager: McpConnectionManager;
        readonly probes: ReadonlyMap<string, ClientProbe>;
        readonly permissionCount: () => number;
    }> {
        await writeConfigs(names);
        const probes = new Map<string, ClientProbe>();
        const manager = new McpConnectionManager({
            clientFactory: (server) => {
                const probe = clientProbe();
                probes.set(server.name, probe);
                return probe.client;
            },
        });
        let permissions = 0;
        const registry = new ToolRegistry();
        await registerNamespacedMcpTools(registry, {
            workspaceRoot,
            userConfigPath,
            projectConfigPath,
            projectTrustStore: trust.reader,
            mcpConnectionManager: manager,
            requestPermission: async (request) => {
                permissions += 1;
                return { requestId: request.id, status: 'allow' };
            },
        });
        return { registry, manager, probes, permissionCount: () => permissions };
    }

    async function writeConfigs(names: {
        readonly user?: readonly string[];
        readonly project?: readonly string[];
    }): Promise<void> {
        const entry = (name: string) => [name, { type: 'local', command: [`${name}-command`] }];
        await writeFile(
            userConfigPath,
            JSON.stringify({ mcp: Object.fromEntries((names.user ?? []).map(entry)) }),
            'utf8',
        );
        await writeFile(
            projectConfigPath,
            JSON.stringify({ mcpServers: Object.fromEntries((names.project ?? []).map(entry)) }),
            'utf8',
        );
    }
});

function clientProbe(): ClientProbe {
    let calls = 0;
    let closes = 0;
    return {
        client: {
            connect: async () => undefined,
            listTools: async () => [{ name: 'echo', inputSchema: { type: 'object' } }],
            callTool: async () => {
                calls += 1;
                return 'echoed';
            },
            close: async () => {
                closes += 1;
            },
        },
        callCount: () => calls,
        closeCount: () => closes,
    };
}

function trustController(): TrustController {
    let decision: ProjectTrustDecision = 'trusted';
    let lookupFails = false;
    return {
        reader: {
            getDecision: async (workspaceRoot) => {
                if (lookupFails) throw new Error('trust lookup failed');
                return trustLookup(workspaceRoot, decision);
            },
        },
        setDecision: (nextDecision) => {
            decision = nextDecision;
            lookupFails = false;
        },
        failLookup: () => {
            lookupFails = true;
        },
    };
}

function trustLookup(workspaceRoot: string, decision: ProjectTrustDecision): ProjectTrustLookup {
    return {
        decision,
        workspaceRoot,
        filePath: join(workspaceRoot, '.trust', 'projects.json'),
        storeState: 'valid',
    };
}

async function invoke(registry: ToolRegistry, name: string, toolCallId: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === name);
    if (advertisement === undefined) throw new Error(`missing MCP advertisement: ${name}`);
    return registry.invoke({
        toolName: name,
        toolCallId,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ text: 'hello' }),
    });
}
