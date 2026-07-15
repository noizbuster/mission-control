import type { PermissionDecision, PermissionRequest, ToolResult } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionEventLog } from '../../session-log.js';
import { ProjectTrustStore } from '../../trust/project-trust-store.js';
import { ToolRegistry } from '../tool-registry.js';
import { completedToolEvent } from '../tool-settlement-events.js';
import { McpConnectionManager } from './connection-manager.js';
import { createSecretRedactor } from './secret-redaction.js';
import { asToolRegistryWithMcp, registerNamespacedMcpTools } from './surfacing.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixturePath = new URL('./fixtures/stdio-fixture-server.mjs', import.meta.url).pathname;
const LONG_TIMEOUT = 15000;

describe('namespaced MCP surfacing resilience', () => {
    let workspaceRoot: string;
    let dataDir: string;

    beforeEach(async () => {
        workspaceRoot = join(tmpdir(), `mctrl-surfacing-resilience-${Date.now()}`);
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
        'gracefully handles a crashing server — registers no tools from that server',
        async () => {
            await writeFile(
                join(workspaceRoot, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'crash-server': {
                            type: 'local',
                            command: [process.execPath, fixturePath, 'crash'],
                            timeoutMs: 4000,
                        },
                    },
                }),
            );
            const registry = new ToolRegistry();
            const alwaysAllow = async (request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: request.id,
                status: 'allow',
                reason: 'test',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysAllow,
            });
            try {
                expect(registry.advertise().filter((tool) => tool.name.startsWith('mcp__'))).toHaveLength(0);
                expect(manager.getWarnings().length).toBeGreaterThan(0);
                expect(manager.getWarnings()[0]).toContain('crash-server');
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'gracefully skips a hung server — other servers still register',
        async () => {
            await writeFile(
                join(workspaceRoot, '.mcp.json'),
                JSON.stringify({
                    mcpServers: {
                        'hung-server': {
                            type: 'local',
                            command: [process.execPath, fixturePath, 'hung'],
                            timeoutMs: 2000,
                        },
                        'normal-server': {
                            type: 'local',
                            command: [process.execPath, fixturePath, 'normal'],
                            timeoutMs: 4000,
                        },
                    },
                }),
            );
            const registry = new ToolRegistry();
            const alwaysAllow = async (request: PermissionRequest): Promise<PermissionDecision> => ({
                requestId: request.id,
                status: 'allow',
                reason: 'test',
            });
            const manager = await registerNamespacedMcpTools(registry, {
                workspaceRoot,
                requestPermission: alwaysAllow,
            });
            try {
                const mcpTools = registry.advertise().filter((tool) => tool.name.startsWith('mcp__'));
                expect(mcpTools.filter((tool) => tool.name.startsWith('mcp__hung_server__'))).toHaveLength(0);
                expect(mcpTools.filter((tool) => tool.name.startsWith('mcp__normal_server__')).length).toBeGreaterThan(
                    0,
                );
                expect(manager.getWarnings().some((warning) => warning.includes('hung-server'))).toBe(true);
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it('projects masked mcp__* tool results through SessionEventLog', () => {
        const secret = 'PROJECTION_SECRET_xyz';
        const toolName = 'mcp__proj_server__echo';
        const redactedResult = createSecretRedactor([secret]).redactValue({
            result: `echo: hello ${secret} world`,
        });
        const toolResult: ToolResult = {
            toolCallId: 'tc_proj_mask_1',
            status: 'completed',
            output: JSON.stringify(redactedResult),
        };
        const log = new SessionEventLog();
        log.append(completedToolEvent('tc_proj_mask_1', toolName, toolResult));
        const events = log.getEvents();
        expect(events).toHaveLength(1);
        const projected = events[0];
        if (projected === undefined) throw new Error('expected one projected event');
        expect(projected.type).toBe('tool.completed');
        expect(projected.message).toContain(toolName);
        const outputJson = projected.toolResult?.output ?? '';
        expect(outputJson).toContain('[REDACTED_CREDENTIAL]');
        expect(outputJson).not.toContain(secret);
    });
});

describe('asToolRegistryWithMcp', () => {
    it('wraps a plain ToolRegistry with an empty manager', async () => {
        const registry = new ToolRegistry();
        const wrapped = asToolRegistryWithMcp(registry);
        expect(wrapped.registry).toBe(registry);
        expect(wrapped.mcpConnectionManager).toBeInstanceOf(McpConnectionManager);
        expect(wrapped.mcpConnectionManager.getServers()).toHaveLength(0);
        await wrapped.mcpConnectionManager.disconnectAll();
    });
});
