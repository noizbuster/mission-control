import { describe, expect, it } from 'vitest';
import { demoManifest, renderPluginProviderValues } from './plugin-runtime-test-support';

describe('TUI plugin runtime provider failures', () => {
    it('reports plugin command failures through diagnostics and toast without crashing the provider', async () => {
        const rendered = renderPluginProviderValues({
            allowedCapabilities: ['ui.command'],
            plugins: [
                {
                    source: 'user',
                    manifest: demoManifest(['ui.command']),
                    setup: (api) => {
                        api.registerCommand({ id: 'demo.fail', title: 'Fail Demo' }, () => {
                            throw new Error('boom');
                        });
                    },
                },
            ],
        });
        await rendered.pluginRuntime.ready;

        const result = await rendered.pluginRuntime.dispatchCommand('demo.fail');

        expect(result).toEqual({ kind: 'failed' });
        expect(rendered.pluginRuntime.diagnostics().at(-1)).toMatchObject({
            pluginName: 'demo-plugin',
            level: 'error',
            code: 'plugin_callback_failed',
            redacted: true,
        });
        expect(rendered.toast.current()).toMatchObject({ message: 'Plugin demo-plugin failed', variant: 'error' });

        rendered.dispose();
    });

    it('disposes plugin registrations when the provider unmounts', async () => {
        const rendered = renderPluginProviderValues({
            allowedCapabilities: ['ui.command'],
            plugins: [
                {
                    source: 'user',
                    manifest: demoManifest(['ui.command']),
                    setup: (api) => {
                        api.registerCommand({ id: 'demo.cleanup', title: 'Cleanup Demo' }, () => {});
                    },
                },
            ],
        });
        await rendered.pluginRuntime.ready;

        expect(rendered.pluginRuntime.commands().map((command) => command.id)).toEqual([
            'demo.manifest',
            'demo.cleanup',
        ]);

        rendered.dispose();

        expect(rendered.pluginRuntime.commands()).toEqual([]);
        expect(rendered.pluginRuntime.slots()).toEqual([]);
        expect(rendered.pluginRuntime.routes()).toEqual([]);
    });
});
