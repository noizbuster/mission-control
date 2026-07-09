import { TuiStores } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { allPluginCapabilities, demoManifest, renderPluginProviderValues } from './plugin-runtime-test-support.js';

describe('TUI plugin runtime provider', () => {
    it('lets a trusted in-process plugin register descriptors and use command, KV, route, dialog, and theme adapters', async () => {
        const rendered = renderPluginProviderValues({
            allowedCapabilities: allPluginCapabilities,
            plugins: [
                {
                    source: 'user',
                    manifest: demoManifest(allPluginCapabilities),
                    setup: (api) => {
                        api.registerSlot({
                            id: 'setup-slot',
                            slot: 'composer.footer',
                            label: 'Setup Slot',
                            componentRef: 'demo.footer',
                        });
                        api.registerRoute({ id: 'setup-route', path: '/plugins/demo/setup', label: 'Setup Route' });
                        api.registerCommand({ id: 'demo.run', title: 'Run Demo' }, async () => {
                            await api.kv.setString('last-run', 'ok');
                            api.route.setRoute({ id: 'plugin:demo', label: 'Demo Plugin', kind: 'plugin' });
                            api.dialog.open({ title: 'Demo Plugin', body: 'Command complete' });
                            await api.theme.savePreference({ activeThemeId: 'no-color', customOverrides: [] });
                        });
                    },
                },
            ],
        });
        await rendered.pluginRuntime.ready;

        expect(
            rendered.pluginRuntime
                .commands()
                .map((command) => command.id)
                .sort(),
        ).toEqual(['demo.manifest', 'demo.run']);
        const result = await rendered.pluginRuntime.dispatchCommand('demo.run');

        expect(result).toEqual({ kind: 'handled' });
        expect(
            rendered.pluginRuntime
                .slots()
                .map((slot) => slot.id)
                .sort(),
        ).toEqual(['manifest-slot', 'setup-slot']);
        expect(
            rendered.pluginRuntime
                .routes()
                .map((route) => route.id)
                .sort(),
        ).toEqual(['manifest-route', 'setup-route']);
        expect(
            rendered.pluginRuntime
                .commands()
                .map((command) => command.id)
                .sort(),
        ).toEqual(['demo.manifest', 'demo.run']);
        expect(
            await new TuiStores.TuiKvStore({ dataDir: rendered.roots.dataDir }).getString(
                'plugin:demo-plugin',
                'last-run',
            ),
        ).toBe('ok');
        expect(rendered.route.current()).toEqual({ id: 'plugin:demo', label: 'Demo Plugin', kind: 'plugin' });
        expect(rendered.dialog.current()).toMatchObject({ title: 'Demo Plugin', body: 'Command complete' });
        expect(rendered.theme.preference().activeThemeId).toBe('no-color');

        rendered.dispose();
    });
});
