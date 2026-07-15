import { type BrowserConnectFn, McpConnectionManager, ProjectTrustStore } from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    allowPermission,
    configureBrowser,
    createBrowserConfigFixture as createFixture,
} from './browser-tool-registry-test-support.js';
import { createInteractiveToolRegistry } from './interactive-coding-tools.js';
import { noLspServers, toolOptions } from './interactive-coding-tools-test-support.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';
import { closeProductionToolRegistry } from './production-tool-registry.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';
import { rm } from 'node:fs/promises';

describe('production browser tool registry', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('omits browser from interactive and noninteractive registries without user configuration', async () => {
        const fixture = await createFixture(tempRoots);

        const interactive = await createInteractiveToolRegistry(
            toolOptions(createBufferedChatOutput().output, fixture.workspaceRoot),
            approvalBroker(vi.fn()),
        );
        const noninteractive = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: denyPermission,
            lspServerManagerDeps: noLspServers,
        });

        expect(interactive.registry.advertise().map((tool) => tool.name)).not.toContain('browser');
        expect(noninteractive.registry.advertise().map((tool) => tool.name)).not.toContain('browser');
        await interactive.mcpConnectionManager.disconnectAll();
        await noninteractive.mcpConnectionManager.disconnectAll();
    });

    it('registers browserURL noninteractively without connecting before denied invocation', async () => {
        const fixture = await createFixture(tempRoots);
        await configureBrowser(fixture.configDir, { browserURL: 'http://127.0.0.1:9222' });
        await new ProjectTrustStore().setDecision(fixture.workspaceRoot, 'trusted');
        const connect = vi.fn<BrowserConnectFn>();
        const requestPermission = vi.fn(denyPermission);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission,
            browserConnect: connect,
            lspServerManagerDeps: noLspServers,
        });
        const browser = result.registry.advertise().find((tool) => tool.name === 'browser');
        if (browser === undefined) throw new Error('browser tool was not registered');

        expect(connect).not.toHaveBeenCalled();
        const settlement = await result.registry.invoke({
            toolCallId: 'browser-http-denied',
            toolName: browser.name,
            advertisedVersion: browser.version,
            argumentsJson: JSON.stringify({ action: 'navigate', url: 'https://example.test' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(requestPermission).toHaveBeenCalledOnce();
        expect(connect).not.toHaveBeenCalled();
        await result.mcpConnectionManager.disconnectAll();
    });

    it('registers browserWSEndpoint interactively without connecting before denied invocation', async () => {
        const fixture = await createFixture(tempRoots);
        const secret = 'configured-endpoint-secret';
        await configureBrowser(fixture.configDir, {
            browserWSEndpoint: `ws://127.0.0.1:9222/devtools/browser/${secret}?token=query-secret`,
        });
        await new ProjectTrustStore().setDecision(fixture.workspaceRoot, 'trusted');
        const connect = vi.fn<BrowserConnectFn>();
        const requestPermission = vi.fn(denyPermission);
        const output = createBufferedChatOutput();

        const result = await createInteractiveToolRegistry(
            {
                ...toolOptions(output.output, fixture.workspaceRoot),
                browserConnect: connect,
            },
            approvalBroker(requestPermission),
        );
        const browser = result.registry.advertise().find((tool) => tool.name === 'browser');
        if (browser === undefined) throw new Error('browser tool was not registered');

        expect(connect).not.toHaveBeenCalled();
        const settlement = await result.registry.invoke({
            toolCallId: 'browser-ws-denied',
            toolName: browser.name,
            advertisedVersion: browser.version,
            argumentsJson: JSON.stringify({ action: 'extract' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(requestPermission).toHaveBeenCalledOnce();
        expect(JSON.stringify(requestPermission.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(requestPermission.mock.calls)).not.toContain('query-secret');
        expect(connect).not.toHaveBeenCalled();
        await result.mcpConnectionManager.disconnectAll();
    });

    it('redacts configured endpoint secrets from production connector failures', async () => {
        const fixture = await createFixture(tempRoots);
        const secret = 'connector-endpoint-secret';
        await configureBrowser(fixture.configDir, {
            browserURL: `http://127.0.0.1:9222/?token=${secret}`,
        });
        await new ProjectTrustStore().setDecision(fixture.workspaceRoot, 'trusted');
        const connect: BrowserConnectFn = async () => {
            throw new Error(`connection rejected ${secret}`);
        };

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowPermission,
            browserConnect: connect,
            lspServerManagerDeps: noLspServers,
        });
        const browser = result.registry.advertise().find((tool) => tool.name === 'browser');
        if (browser === undefined) throw new Error('browser tool was not registered');

        const settlement = await result.registry.invoke({
            toolCallId: 'browser-secret-failure',
            toolName: browser.name,
            advertisedVersion: browser.version,
            argumentsJson: JSON.stringify({ action: 'extract' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(JSON.stringify(settlement)).not.toContain(secret);
        expect(JSON.stringify(settlement)).toContain('[REDACTED_CREDENTIAL]');
        await closeProductionToolRegistry(result);
    });

    it('closes an allowed production browser connection exactly once', async () => {
        const fixture = await createFixture(tempRoots);
        await configureBrowser(fixture.configDir, { browserURL: 'http://127.0.0.1:9222' });
        await new ProjectTrustStore().setDecision(fixture.workspaceRoot, 'trusted');
        let closeCalls = 0;
        let disconnectCalls = 0;
        const connect: BrowserConnectFn = async () => ({
            connected: true,
            async newPage() {
                return {
                    goto: async () => undefined,
                    url: () => 'about:blank',
                    title: async () => '',
                    extractText: async () => 'production browser text',
                    extractHtml: async () => '<main>production browser text</main>',
                    screenshot: async () => new Uint8Array([1]),
                    close: async () => {
                        closeCalls += 1;
                    },
                };
            },
            disconnect: async () => {
                disconnectCalls += 1;
            },
        });

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowPermission,
            browserConnect: connect,
            lspServerManagerDeps: noLspServers,
        });
        const browser = result.registry.advertise().find((tool) => tool.name === 'browser');
        if (browser === undefined) throw new Error('browser tool was not registered');

        const settlement = await result.registry.invoke({
            toolCallId: 'browser-production-success',
            toolName: browser.name,
            advertisedVersion: browser.version,
            argumentsJson: JSON.stringify({ action: 'extract' }),
        });
        await closeProductionToolRegistry(result);
        await closeProductionToolRegistry(result);

        expect(settlement.result.status).toBe('completed');
        expect(closeCalls).toBe(1);
        expect(disconnectCalls).toBe(1);
    });

    it('disconnects an owned MCP manager when later registry setup fails', async () => {
        const fixture = await createFixture(tempRoots);
        const disconnectAll = vi.spyOn(McpConnectionManager.prototype, 'disconnectAll');

        const setup = createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowPermission,
            lspServerManagerDeps: {
                commandExists: async () => {
                    throw new Error('LSP detection failed');
                },
            },
        });

        await expect(setup).rejects.toThrow('LSP detection failed');
        expect(disconnectAll).toHaveBeenCalledOnce();
    });

    it('does not disconnect an injected reusable MCP manager during normal teardown', async () => {
        const fixture = await createFixture(tempRoots);
        const mcpConnectionManager = new McpConnectionManager();
        const disconnectAll = vi.spyOn(mcpConnectionManager, 'disconnectAll');
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowPermission,
            mcpConnectionManager,
            lspServerManagerDeps: noLspServers,
        });

        await closeProductionToolRegistry(result);

        expect(disconnectAll).not.toHaveBeenCalled();
    });

    it('surfaces sticky browser cleanup failures from production teardown', async () => {
        const fixture = await createFixture(tempRoots);
        await configureBrowser(fixture.configDir, { browserURL: 'http://127.0.0.1:9222' });
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission: allowPermission,
            lspServerManagerDeps: noLspServers,
        });
        if (result.browserTool === null) throw new Error('browser tool was not registered');
        vi.spyOn(result.browserTool, 'getCleanupErrors').mockReturnValue(['[REDACTED_CREDENTIAL] cleanup failed']);

        await expect(closeProductionToolRegistry(result)).rejects.toThrow('production tool cleanup failed');
    });
});

function approvalBroker(requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>) {
    return {
        requestApproval: requestPermission,
        requestPermission,
        primeApproval: () => undefined,
        answer: () => false,
        cancel: () => undefined,
        hasPending: () => false,
        setApprovalLevel: () => undefined,
    };
}

async function denyPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return { requestId: request.id, status: 'deny', reason: 'test denial' };
}
