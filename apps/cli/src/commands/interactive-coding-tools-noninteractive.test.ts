import { afterEach, describe, expect, it } from 'vitest';
import { allowAllPermission, noLspServers, throwingResolver } from './interactive-coding-tools-test-support.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('non-interactive coding tool registry surface', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises glob, todowrite, webfetch, task, and skill through createNonInteractiveToolRegistry', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-registry-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            resolveSdkModel: throwingResolver,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            sessionId: 'session_noninteractive_tools',
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).toContain('glob');
        expect(advertised).toContain('todowrite');
        expect(advertised).toContain('webfetch');
        expect(advertised).toContain('task');
        expect(advertised).toContain('skill');
        const taskAd = result.registry
            .advertise()
            .find((advertisement: { name: string }) => advertisement.name === 'task');
        expect(taskAd?.guideline).toBeDefined();
        expect(taskAd?.capabilityClasses).toContain('subagent');
    });

    it('does NOT advertise mcp__* or lsp by default with empty MCP config and no LspClient', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-no-mcp-lsp-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            lspServerManagerDeps: noLspServers,
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('lsp');
        expect(advertised.some((name) => name.startsWith('mcp__'))).toBe(false);
    });

    it('omits the task tool when resolveSdkModel is not provided', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mctrl-noninteractive-no-task-'));
        tempRoots.push(workspaceRoot);

        const result = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
        });

        const advertised = result.registry.advertise().map((advertisement: { name: string }) => advertisement.name);
        expect(advertised).not.toContain('task');
        expect(advertised).toContain('webfetch');
        expect(advertised).toContain('glob');
        expect(advertised).toContain('todowrite');
        expect(advertised).toContain('skill');
    });
});
