import type { PermissionDecision, PermissionRequest, ToolResult } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionEventLog } from '../../session-log.js';
import { createChildToolRegistry } from '../task-tool.js';
import { ToolRegistry } from '../tool-registry.js';
import { completedToolEvent } from '../tool-settlement-events.js';
import { McpConnectionManager } from './connection-manager.js';
import { createSecretRedactor } from './secret-redaction.js';
import { mcpToolName, registerNamespacedMcpTools, sanitizeMcpName } from './surfacing.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixturePath = new URL('./fixtures/stdio-fixture-server.mjs', import.meta.url).pathname;
const LONG_TIMEOUT = 15000;

describe('sanitizeMcpName', () => {
    it('keeps alphanumeric and underscores unchanged', () => {
        expect(sanitizeMcpName('my_server_01')).toBe('my_server_01');
    });

    it('collapses non-alphanumeric runs into a single underscore', () => {
        expect(sanitizeMcpName('my-server.name')).toBe('my_server_name');
    });

    it('strips leading and trailing separators', () => {
        expect(sanitizeMcpName('---hello---')).toBe('hello');
    });

    it('strips leading separators (e.g. @ in package scopes)', () => {
        expect(sanitizeMcpName('@scope/server')).toBe('scope_server');
    });

    it('returns empty string for fully non-alphanumeric input', () => {
        expect(sanitizeMcpName('---')).toBe('');
    });
});

describe('mcpToolName', () => {
    it('produces mcp__ prefix with sanitized server and tool names', () => {
        expect(mcpToolName('my-server', 'read_file')).toBe('mcp__my_server__read_file');
    });

    it('handles dot-scoped server names', () => {
        expect(mcpToolName('@acme/mcp', 'search')).toBe('mcp__acme_mcp__search');
    });
});

describe('registerNamespacedMcpTools', () => {
    let workspaceRoot: string;

    beforeEach(async () => {
        workspaceRoot = join(tmpdir(), `mctrl-surfacing-test-${Date.now()}`);
        await mkdir(workspaceRoot, { recursive: true });
    });

    afterEach(async () => {
        await rm(workspaceRoot, { recursive: true, force: true });
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
        'child registry excludes mcp__* tools (network capability dropped by child-policy)',
        async () => {
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'child-exclude': {
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
                const parentNames = registry.advertise().map((a) => a.name);
                expect(parentNames).toContain('mcp__child_exclude__echo');

                const child = createChildToolRegistry(registry);
                const childNames = child.advertise().map((a) => a.name);
                expect(childNames).not.toContain('mcp__child_exclude__echo');
                expect(childNames).not.toContain('mcp__child_exclude__greet');
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it(
        'gracefully handles a crashing server — registers no tools from that server',
        async () => {
            const mcpJson = JSON.stringify({
                mcpServers: {
                    'crash-server': {
                        type: 'local',
                        command: [process.execPath, fixturePath, 'crash'],
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
                const mcpTools = registry.advertise().filter((a) => a.name.startsWith('mcp__'));
                expect(mcpTools).toHaveLength(0);
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
            const mcpJson = JSON.stringify({
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
                const mcpTools = registry.advertise().filter((a) => a.name.startsWith('mcp__'));
                const hungTools = mcpTools.filter((a) => a.name.startsWith('mcp__hung_server__'));
                const normalTools = mcpTools.filter((a) => a.name.startsWith('mcp__normal_server__'));

                expect(hungTools).toHaveLength(0);
                expect(normalTools.length).toBeGreaterThan(0);
                expect(manager.getWarnings().some((w) => w.includes('hung-server'))).toBe(true);
            } finally {
                await manager.disconnectAll();
            }
        },
        LONG_TIMEOUT,
    );

    it('mcp__* tool result projects through SessionEventLog with secrets masked', () => {
        const secret = 'PROJECTION_SECRET_xyz';
        const toolName = 'mcp__proj_server__echo';

        // Redact via the real production redactor (not a hand .replace).
        const redactor = createSecretRedactor([secret]);
        const rawResult = { result: `echo: hello ${secret} world` };
        const redactedResult = redactor.redactValue(rawResult);

        // Build the ToolResult the settlement would carry.
        const toolResult: ToolResult = {
            toolCallId: 'tc_proj_mask_1',
            status: 'completed',
            output: JSON.stringify(redactedResult),
        };

        // Build the tool.completed event via the real event builder.
        const event = completedToolEvent('tc_proj_mask_1', toolName, toolResult);

        // Push through the real SessionEventLog projection surface.
        const log = new SessionEventLog();
        log.append(event);

        // Assert projection: the event flows through getEvents().
        const events = log.getEvents();
        expect(events).toHaveLength(1);
        const projected = events[0];
        if (projected === undefined) {
            throw new Error('expected one projected event');
        }
        expect(projected.type).toBe('tool.completed');
        expect(projected.message).toContain(toolName);

        // Assert masking: [REDACTED] present, raw secret absent.
        const outputJson = projected.toolResult?.output ?? '';
        expect(outputJson).toContain('[REDACTED]');
        expect(outputJson).not.toContain(secret);
    });
});

describe('asToolRegistryWithMcp', () => {
    it('wraps a plain ToolRegistry with an empty manager', async () => {
        const { asToolRegistryWithMcp } = await import('./surfacing.js');
        const registry = new ToolRegistry();
        const wrapped = asToolRegistryWithMcp(registry);

        expect(wrapped.registry).toBe(registry);
        expect(wrapped.mcpConnectionManager).toBeInstanceOf(McpConnectionManager);
        expect(wrapped.mcpConnectionManager.getServers()).toHaveLength(0);
        await wrapped.mcpConnectionManager.disconnectAll();
    });
});
