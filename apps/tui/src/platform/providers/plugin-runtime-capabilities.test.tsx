import { describe, expect, it } from 'vitest';
import { allPluginCapabilities, demoManifest, renderPluginProviderValues } from './plugin-runtime-test-support';

describe('TUI plugin runtime provider capabilities', () => {
    it('keeps denied capabilities from registering anything and records redacted diagnostics', async () => {
        const rendered = renderPluginProviderValues({
            allowedCapabilities: [],
            plugins: [
                {
                    source: 'user',
                    manifest: demoManifest(['ui.slot', 'ui.route', 'ui.command', 'ui.kv']),
                    setup: (api) => {
                        api.registerSlot({
                            id: 'denied-slot',
                            slot: 'status.right',
                            label: 'Denied',
                            componentRef: 'denied',
                        });
                        api.registerRoute({ id: 'denied-route', path: '/plugins/denied', label: 'Denied' });
                        api.registerCommand({ id: 'denied.run', title: 'Denied' }, async () => {
                            await api.kv.setString('secret', 'nope');
                        });
                    },
                },
            ],
        });
        await rendered.pluginRuntime.ready;

        expect(rendered.pluginRuntime.slots()).toEqual([]);
        expect(rendered.pluginRuntime.routes()).toEqual([]);
        expect(rendered.pluginRuntime.commands()).toEqual([]);
        expect(rendered.pluginRuntime.diagnostics().map((diagnostic) => diagnostic.code)).toEqual([
            'capability_denied',
            'capability_denied',
            'capability_denied',
            'capability_denied',
            'capability_required',
            'capability_required',
            'capability_required',
        ]);
        expect(rendered.pluginRuntime.diagnostics().every((diagnostic) => diagnostic.redacted)).toBe(true);

        rendered.dispose();
    });

    it('leaves project descriptors inert until workspace trust is granted', async () => {
        const rendered = renderPluginProviderValues({
            allowedCapabilities: allPluginCapabilities,
            plugins: [{ source: 'project', manifest: demoManifest(allPluginCapabilities) }],
        });
        await rendered.pluginRuntime.ready;

        expect(rendered.pluginRuntime.slots()).toEqual([]);
        expect(rendered.pluginRuntime.routes()).toEqual([]);
        expect(rendered.pluginRuntime.commands()).toEqual([]);
        expect(rendered.pluginRuntime.diagnostics().map((diagnostic) => diagnostic.code)).toEqual([
            'workspace_not_trusted',
        ]);

        rendered.dispose();
    });
});
