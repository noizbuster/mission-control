import { describe, expect, it } from 'vitest';
import {
    TUI_KV_VALUE_SCHEMA_KEYS,
    TUI_PLUGIN_CAPABILITIES,
    TUI_PLUGIN_DIAGNOSTIC_LEVELS,
    TuiFrecencyRecordSchema,
    TuiKvEntrySchema,
    TuiKvNamespaceSchema,
    TuiLocalPreferencesSchema,
    TuiPluginCapabilitySchema,
    TuiPluginCommandDescriptorSchema,
    TuiPluginDiagnosticSchema,
    TuiPluginManifestSchema,
    TuiPluginRedactedErrorSchema,
    TuiPluginRouteDescriptorSchema,
    TuiPluginSlotDescriptorSchema,
    TuiPromptHistoryEntrySchema,
    TuiPromptStashEntrySchema,
    TuiThemePreferenceSchema,
} from './tui-provider-data';

describe('TUI provider data schemas', () => {
    it('validates typed KV namespaces and rejects mismatched schema-key values', () => {
        // Given
        const namespace = {
            namespace: 'chat-input',
            entries: [
                { key: 'draft', schemaKey: 'string', value: 'hello' },
                { key: 'weights', schemaKey: 'numberArray', value: [1, 2] },
            ],
        };

        // When
        const parsed = TuiKvNamespaceSchema.parse(namespace);

        // Then
        expect(parsed.entries).toHaveLength(2);
        expect(TUI_KV_VALUE_SCHEMA_KEYS).toEqual(['string', 'number', 'boolean', 'stringArray', 'numberArray']);
        expect(() => TuiKvEntrySchema.parse({ key: 'draft', schemaKey: 'string', value: 1 })).toThrow();
        expect(() => TuiKvNamespaceSchema.parse({ ...namespace, extra: true })).toThrow();
    });

    it('validates local preferences and prompt records with strict object shapes', () => {
        // Given
        const preferences = {
            recentModels: ['openai/gpt-5.5'],
            favoriteModels: ['anthropic/claude-sonnet-4-6'],
            variantCyclingHints: [{ modelId: 'openai/gpt-5.5', variantId: 'reasoning-high' }],
            sessionPins: ['session_1'],
            uiToggles: [{ key: 'show-graph', value: true }],
            modelContextPrefs: [
                { modelKey: 'openai/gpt-5.5', contextLimit: 200_000, autoCompactThreshold: 0.8 },
            ],
        };

        // When
        const parsed = TuiLocalPreferencesSchema.parse(preferences);

        // Then
        expect(parsed.recentModels).toEqual(['openai/gpt-5.5']);
        expect(parsed.modelContextPrefs).toEqual([
            { modelKey: 'openai/gpt-5.5', contextLimit: 200_000, autoCompactThreshold: 0.8 },
        ]);
        expect(TuiLocalPreferencesSchema.parse({ ...preferences, modelContextPrefs: undefined }).modelContextPrefs).toEqual(
            [],
        );
        expect(TuiPromptHistoryEntrySchema.parse({ id: 'h1', text: 'prompt', timestamp: 1 }).text).toBe('prompt');
        expect(
            TuiPromptStashEntrySchema.parse({ id: 's1', text: '', cursorOffset: 0, timestamp: 1 }).cursorOffset,
        ).toBe(0);
        expect(() => TuiLocalPreferencesSchema.parse({ ...preferences, unknown: true })).toThrow();
        expect(() =>
            TuiPromptHistoryEntrySchema.parse({ id: 'h1', text: 'prompt', timestamp: 1, parts: [] }),
        ).toThrow();
    });

    it('validates frecency and theme preference records', () => {
        // Given
        const theme = {
            activeThemeId: 'midnight',
            customOverrides: [{ key: 'accent', value: '#88ccff' }],
        };

        // When / Then
        expect(
            TuiFrecencyRecordSchema.parse({ key: '/tmp/file.ts', accessCount: 2, firstSeenAt: 1, lastAccessedAt: 3 })
                .accessCount,
        ).toBe(2);
        expect(TuiThemePreferenceSchema.parse(theme).activeThemeId).toBe('midnight');
        expect(() => TuiThemePreferenceSchema.parse({ ...theme, customOverrides: [{ key: 'accent' }] })).toThrow();
        expect(() =>
            TuiFrecencyRecordSchema.parse({ key: 'x', accessCount: 0, firstSeenAt: 1, lastAccessedAt: 2 }),
        ).toThrow();
    });

    it('validates plugin manifests capabilities and diagnostics', () => {
        // Given
        const manifest = {
            name: 'demo-plugin',
            version: '1.0.0',
            capabilities: ['ui.slot', 'ui.route', 'ui.command', 'runtime.events.read'],
            slots: [{ id: 'status-chip', slot: 'status.right', label: 'Status chip', componentRef: 'statusChip' }],
            routes: [{ id: 'run-log', path: '/plugins/demo/run-log', label: 'Run log' }],
            commands: [{ id: 'demo.say-hello', title: 'Say hello', defaultKeybinding: 'ctrl+h' }],
            entryPoint: './plugin.js',
            description: 'Demo plugin',
        };

        // When
        const parsed = TuiPluginManifestSchema.parse(manifest);

        // Then
        expect(parsed.capabilities).toEqual(['ui.slot', 'ui.route', 'ui.command', 'runtime.events.read']);
        expect(parsed.slots[0]?.componentRef).toBe('statusChip');
        expect(parsed.routes[0]?.path).toBe('/plugins/demo/run-log');
        expect(parsed.commands[0]?.title).toBe('Say hello');
        expect(TUI_PLUGIN_CAPABILITIES).toContain('keymap.register');
        expect(TUI_PLUGIN_DIAGNOSTIC_LEVELS).toEqual(['error', 'warning', 'info']);
        expect(
            TuiPluginSlotDescriptorSchema.parse({
                id: 'panel',
                slot: 'overlay.panel',
                label: 'Panel',
                componentRef: 'panelComponent',
            }).slot,
        ).toBe('overlay.panel');
        expect(
            TuiPluginRouteDescriptorSchema.parse({ id: 'settings', path: '/plugins/demo/settings', label: 'Settings' })
                .label,
        ).toBe('Settings');
        expect(TuiPluginCommandDescriptorSchema.parse({ id: 'demo.run', title: 'Run demo' }).id).toBe('demo.run');
        expect(
            TuiPluginCapabilitySchema.parse({ pluginName: 'demo-plugin', capability: 'ui.slot', enabled: true })
                .capability,
        ).toBe('ui.slot');
        expect(
            TuiPluginDiagnosticSchema.parse({
                pluginName: 'demo-plugin',
                level: 'warning',
                code: 'route_skipped',
                message: 'Skipped optional route',
                redacted: false,
                timestamp: 1,
            }).level,
        ).toBe('warning');
        expect(
            TuiPluginRedactedErrorSchema.parse({
                pluginName: 'demo-plugin',
                code: 'load_failed',
                message: 'Plugin error redacted',
                redacted: true,
            }).redacted,
        ).toBe(true);
        expect(() => TuiPluginManifestSchema.parse({ ...manifest, capabilities: ['network.raw'] })).toThrow();
        expect(() => TuiPluginManifestSchema.parse({ ...manifest, renderer: 'raw' })).toThrow();
        expect(() =>
            TuiPluginSlotDescriptorSchema.parse({
                id: 'panel',
                slot: 'overlay.panel',
                label: 'Panel',
                componentRef: 'panelComponent',
                rawRenderer: true,
            }),
        ).toThrow();
        expect(() => TuiPluginDiagnosticSchema.parse({ pluginName: 'demo-plugin', level: 'debug' })).toThrow();
        expect(() =>
            TuiPluginRedactedErrorSchema.parse({
                pluginName: 'demo-plugin',
                code: 'load_failed',
                message: 'Plugin error redacted',
                redacted: false,
            }),
        ).toThrow();
    });
});
