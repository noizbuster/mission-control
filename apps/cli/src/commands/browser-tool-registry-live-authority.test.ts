import { type BrowserConnectFn, ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    allowPermission,
    configureBrowser,
    createBrowserConfigFixture as createFixture,
} from './browser-tool-registry-test-support.js';
import { noLspServers } from './interactive-coding-tools-test-support.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';
import { closeProductionToolRegistry } from './production-tool-registry.js';
import { rm } from 'node:fs/promises';

describe('production browser live authority', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('rereads the canonical trust store before a production browser invocation', async () => {
        const fixture = await createFixture(tempRoots);
        await configureBrowser(fixture.configDir, { browserURL: 'http://127.0.0.1:9222' });
        const projectTrustStore = new ProjectTrustStore();
        await projectTrustStore.setDecision(fixture.workspaceRoot, 'trusted');
        const connect = vi.fn<BrowserConnectFn>();
        const requestPermission = vi.fn(allowPermission);
        const result = await createNonInteractiveToolRegistry({
            workspaceRoot: fixture.workspaceRoot,
            requestPermission,
            projectTrustStore,
            browserConnect: connect,
            lspServerManagerDeps: noLspServers,
        });
        const browser = result.registry.advertise().find((tool) => tool.name === 'browser');
        if (browser === undefined) throw new Error('browser tool was not registered');
        await new ProjectTrustStore().setDecision(fixture.workspaceRoot, 'denied');

        const settlement = await result.registry.invoke({
            toolCallId: 'browser-canonical-trust-revoked',
            toolName: browser.name,
            advertisedVersion: browser.version,
            argumentsJson: JSON.stringify({ action: 'extract' }),
        });

        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { retryable: false },
        });
        expect(JSON.stringify(settlement)).toContain('workspace_untrusted');
        expect(requestPermission).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        await closeProductionToolRegistry(result);
    });
});
