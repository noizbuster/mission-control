import { describe, expect, it } from 'vitest';
import { TuiPluginHostRegistry } from './tui-plugin-host.js';

const trustedLookup = async () => ({
    decision: 'trusted' as const,
    workspaceRoot: '/workspace/project',
    filePath: '/data/trust/projects.json',
    storeState: 'valid' as const,
});

const untrustedLookup = async () => ({
    decision: 'unknown' as const,
    workspaceRoot: '/workspace/project',
    filePath: '/data/trust/projects.json',
    storeState: 'missing' as const,
});

describe('TuiPluginHostRegistry', () => {
    it('keeps project-local descriptors inert until the workspace is trusted', async () => {
        // Given
        const registry = new TuiPluginHostRegistry({
            workspaceRoot: '/workspace/project',
            allowedCapabilities: ['ui.slot', 'ui.command'],
            trustLookup: untrustedLookup,
        });

        // When
        const result = await registry.loadManifest({ source: 'project', manifest: demoManifest() });

        // Then
        expect(result.status).toBe('blocked');
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('workspace_not_trusted');
        expect(registry.listSlots()).toEqual([]);
        expect(registry.listCommands()).toEqual([]);
    });

    it('registers only trusted descriptors whose capabilities are declared and allowed', async () => {
        // Given
        const registry = new TuiPluginHostRegistry({
            workspaceRoot: '/workspace/project',
            allowedCapabilities: ['ui.slot', 'ui.command'],
            trustLookup: trustedLookup,
        });

        // When
        const result = await registry.loadManifest({ source: 'project', manifest: demoManifest() });

        // Then
        expect(result.status).toBe('loaded');
        expect(registry.listSlots().map((slot) => slot.id)).toEqual(['demo.status-chip']);
        expect(registry.listCommands().map((command) => command.id)).toEqual(['demo.say-hello']);
        expect(registry.listRoutes()).toEqual([]);
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('capability_denied');
    });

    it('exposes a narrow host API and disposal removes every registration', async () => {
        // Given
        const registry = new TuiPluginHostRegistry({
            workspaceRoot: '/workspace/project',
            allowedCapabilities: ['ui.slot', 'ui.command'],
            trustLookup: trustedLookup,
        });

        // When
        const result = await registry.loadManifest({ source: 'project', manifest: demoManifest() });
        if (result.status !== 'loaded') {
            throw new Error('expected demo plugin to load');
        }
        const hostApi = result.hostApi;
        registry.disposePlugin('demo');

        // Then
        expect(hostApi).toBeDefined();
        expect(Object.keys(hostApi ?? {}).sort()).toEqual([
            'capabilities',
            'pluginName',
            'registerCommand',
            'registerRoute',
            'registerSlot',
        ]);
        expect('runtime' in (hostApi ?? {})).toBe(false);
        expect('fs' in (hostApi ?? {})).toBe(false);
        expect('network' in (hostApi ?? {})).toBe(false);
        expect('providerCredentials' in (hostApi ?? {})).toBe(false);
        expect(registry.listSlots()).toEqual([]);
        expect(registry.listCommands()).toEqual([]);
    });
});

function demoManifest(): unknown {
    return {
        name: 'demo',
        version: '1.0.0',
        capabilities: ['ui.slot', 'ui.route', 'ui.command'],
        slots: [{ id: 'demo.status-chip', slot: 'status.right', label: 'Status chip', componentRef: 'statusChip' }],
        routes: [{ id: 'demo.run-log', path: '/plugins/demo/run-log', label: 'Run log' }],
        commands: [{ id: 'demo.say-hello', title: 'Say hello' }],
    };
}
