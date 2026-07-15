import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectTrustStore } from '../../trust/project-trust-store.js';
import { ToolRegistry } from '../tool-registry.js';
import { registerNamespacedMcpTools } from './surfacing.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixturePath = new URL('./fixtures/stdio-fixture-server.mjs', import.meta.url).pathname;
const LONG_TIMEOUT = 15000;

describe('registerNamespacedMcpTools', () => {
    let workspaceRoot: string;
    let dataDir: string;

    beforeEach(async () => {
        workspaceRoot = join(tmpdir(), `mctrl-surfacing-test-${Date.now()}`);
        dataDir = `${workspaceRoot}-data`;
        await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(dataDir, { recursive: true })]);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all([
            rm(workspaceRoot, { recursive: true, force: true }),
            rm(dataDir, { recursive: true, force: true }),
        ]);
    });

    it(
        'registers mcp__* tools from a stdio fixture server',
        async () => {
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'test-fixture': {
                        type: 'local',
                        command: [process.execPath, fixturePath, 'normal'],
                        timeoutMs: 4000,
                    },
                },
            });
            await writeFile(join(workspaceRoot, '.mcp.json'), mcpJson);

            const registry = new ToolRegistry();
            const alwaysAllow = async (_request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: _request.id,
                status: 'allow',
                reason: 'test',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysAllow,
            });

            try {
                const advertised = registry.advertise();
                const mcpTools = advertised.filter((a) => a.name.startsWith('mcp__'));
                const names = mcpTools.map((a) => a.name);

                expect(names).toContain('mcp__test_fixture__echo');
                expect(names).toContain('mcp__test_fixture__greet');
                expect(names).toContain('mcp__test_fixture__fail');

                for (const ad of mcpTools) {
                    expect(ad.capabilityClasses).toContain('network');
                    expect(ad.guideline).toContain('test-fixture');
                }
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'keeps tools from colliding server names independently addressable',
        async () => {
            // Given
            await writeFile(
                join(workspaceRoot, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'foo-bar': { type: 'local', command: [process.execPath, fixturePath, 'normal'] },
                        foo_bar: { type: 'local', command: [process.execPath, fixturePath, 'normal'] },
                    },
                }),
            );
            const registry = new ToolRegistry();

            // When
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: async (request) => ({ requestId: request.id, status: 'allow' }),
            });

            try {
                const names = registry
                    .advertise()
                    .map((advertisement) => advertisement.name)
                    .filter((name) => name.startsWith('mcp__foo_bar__'));

                // Then
                expect(names).toHaveLength(6);
                expect(new Set(names).size).toBe(6);
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'self-gates: execute throws when permission is denied',
        async () => {
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'deny-test': {
                        type: 'local',
                        command: [process.execPath, fixturePath, 'normal'],
                        timeoutMs: 4000,
                    },
                },
            });
            await writeFile(join(workspaceRoot, '.mcp.json'), mcpJson);

            const registry = new ToolRegistry();
            const alwaysDeny = async (_request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: _request.id,
                status: 'deny',
                reason: 'test deny',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysDeny,
            });

            try {
                const advertised = registry.advertise();
                const echoAd = advertised.find((a) => a.name === 'mcp__deny_test__echo');
                if (echoAd === undefined) {
                    throw new Error('expected mcp__deny_test__echo to be advertised');
                }

                const settlement = await registry.invoke({
                    toolName: 'mcp__deny_test__echo',
                    toolCallId: 'tc1',
                    advertisedVersion: echoAd.version,
                    argumentsJson: JSON.stringify({ text: 'hello' }),
                });
                expect(settlement.result.status).toBe('failed');
                expect(settlement.result.error?.code).toBe('tool_failed');
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'invoke returns the fixture server result when allowed',
        async () => {
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'invoke-test': {
                        type: 'local',
                        command: [process.execPath, fixturePath, 'normal'],
                        timeoutMs: 4000,
                    },
                },
            });
            await writeFile(join(workspaceRoot, '.mcp.json'), mcpJson);

            const registry = new ToolRegistry();
            const alwaysAllow = async (_request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: _request.id,
                status: 'allow',
                reason: 'test',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysAllow,
            });

            try {
                const advertised = registry.advertise();
                const echoAd = advertised.find((a) => a.name === 'mcp__invoke_test__echo');
                if (echoAd === undefined) {
                    throw new Error('expected mcp__invoke_test__echo to be advertised');
                }

                const settlement = await registry.invoke({
                    toolName: 'mcp__invoke_test__echo',
                    toolCallId: 'tc2',
                    advertisedVersion: echoAd.version,
                    argumentsJson: JSON.stringify({ text: 'hello world' }),
                });
                expect(settlement.result.status).toBe('completed');
                if (settlement.modelOutput === undefined) {
                    throw new Error('expected modelOutput on mcp__* settlement');
                }
                const text = settlement.modelOutput.content;
                expect(text).toContain('hello world');
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'redacts injected MCP credentials echoed through tool descriptions and schema keys',
        async () => {
            // Given
            const secret = ['mcp', 'metadata', 'credential'].join('_');
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'metadata-test': {
                        type: 'local',
                        command: [process.execPath, fixturePath, 'metadata-secret'],
                        environment: { MCP_TEST_SECRET: secret },
                        timeoutMs: 4000,
                    },
                },
            });
            await writeFile(join(workspaceRoot, '.mcp.json'), mcpJson);
            const registry = new ToolRegistry();
            const alwaysAllow = async (request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: request.id,
                status: 'allow',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysAllow,
            });

            try {
                // When
                const observable = JSON.stringify(registry.advertise());

                // Then
                expect(observable).toContain('[REDACTED_CREDENTIAL]');
                expect(observable).not.toContain(secret);
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );
});
