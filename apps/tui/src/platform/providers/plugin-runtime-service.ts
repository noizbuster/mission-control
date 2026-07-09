import type { TuiPluginHostApi, TuiPluginHostRegistry } from '@mission-control/core';
import {
    type TuiPluginCapabilityId,
    type TuiPluginCommandDescriptor,
    TuiPluginCommandDescriptorSchema,
    type TuiPluginDiagnostic,
    TuiPluginDiagnosticSchema,
    type TuiPluginManifest,
    type TuiPluginRouteDescriptor,
    TuiPluginRouteDescriptorSchema,
    type TuiPluginSlotDescriptor,
    TuiPluginSlotDescriptorSchema,
} from '@mission-control/protocol';
import { createSignal, onCleanup } from 'solid-js';
import type { TuiToastService } from './clipboard-toast-context.js';
import type {
    TuiPluginCommandHandler,
    TuiPluginDispatchResult,
    TuiPluginKvStoreLike,
    TuiPluginManifestStoreLike,
    TuiPluginRuntimeApi,
    TuiPluginRuntimeDefinition,
    TuiPluginRuntimeService,
} from './plugin-runtime-types.js';
import type { TuiDialogService, TuiRouteService, TuiThemeService } from './route-dialog-theme-context.js';

type RegisteredCommand = {
    readonly pluginName: string;
    readonly handler: TuiPluginCommandHandler;
    readonly dispose: () => void;
};

type CreateTuiPluginRuntimeServiceInput = {
    readonly registry: TuiPluginHostRegistry;
    readonly manifestStore: TuiPluginManifestStoreLike;
    readonly kvStore: TuiPluginKvStoreLike;
    readonly dialog: TuiDialogService;
    readonly route: TuiRouteService;
    readonly theme: TuiThemeService;
    readonly toast: TuiToastService;
    readonly now: () => number;
    readonly plugins: readonly TuiPluginRuntimeDefinition[];
};

export function createTuiPluginRuntimeService(input: CreateTuiPluginRuntimeServiceInput): TuiPluginRuntimeService {
    const [slots, setSlots] = createSignal<readonly TuiPluginSlotDescriptor[]>([]);
    const [routes, setRoutes] = createSignal<readonly TuiPluginRouteDescriptor[]>([]);
    const [commands, setCommands] = createSignal<readonly TuiPluginCommandDescriptor[]>([]);
    const [diagnostics, setDiagnostics] = createSignal<readonly TuiPluginDiagnostic[]>([]);
    const registeredCommands = new Map<string, RegisteredCommand>();
    const loadedPlugins = new Set<string>();
    let disposed = false;

    const ready = activatePlugins();

    onCleanup(() => {
        disposed = true;
        for (const command of registeredCommands.values()) command.dispose();
        registeredCommands.clear();
        for (const pluginName of loadedPlugins) input.registry.disposePlugin(pluginName);
        refreshSignals();
    });

    async function activatePlugins(): Promise<void> {
        const storedPlugins = (await input.manifestStore.listManifests()).map((manifest) => ({
            source: 'user',
            manifest,
        })) satisfies readonly TuiPluginRuntimeDefinition[];
        for (const plugin of [...storedPlugins, ...input.plugins]) {
            await activatePlugin(plugin);
        }
        refreshSignals();
    }

    async function activatePlugin(plugin: TuiPluginRuntimeDefinition): Promise<void> {
        const loadResult = await input.registry.loadManifest({ source: plugin.source, manifest: plugin.manifest });
        await recordDiagnostics(loadResult.diagnostics);
        if (loadResult.status !== 'loaded' || disposed) {
            refreshSignals();
            return;
        }
        loadedPlugins.add(loadResult.manifest.name);
        await input.manifestStore.saveManifest(loadResult.manifest);
        if (plugin.setup !== undefined) {
            await runSetup(plugin.setup, createRuntimeApi(loadResult.manifest, loadResult.hostApi));
        }
        refreshSignals();
    }

    async function runSetup(setup: TuiPluginRuntimeDefinition['setup'], api: TuiPluginRuntimeApi): Promise<void> {
        if (setup === undefined) return;
        try {
            await setup(api);
        } catch (error: unknown) {
            if (error instanceof Error) {
                await reportFailure(api.pluginName, 'plugin_setup_failed', error.message);
                return;
            }
            await reportFailure(api.pluginName, 'plugin_setup_failed', 'Plugin setup failed');
        }
    }

    function createRuntimeApi(manifest: TuiPluginManifest, hostApi: TuiPluginHostApi): TuiPluginRuntimeApi {
        const namespace = `plugin:${manifest.name}`;
        const api: TuiPluginRuntimeApi = {
            pluginName: manifest.name,
            capabilities: hostApi.capabilities,
            registerSlot: (descriptor: TuiPluginSlotDescriptor) => {
                if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.slot')) return;
                hostApi.registerSlot(TuiPluginSlotDescriptorSchema.parse(descriptor));
                refreshSignals();
            },
            registerRoute: (descriptor: TuiPluginRouteDescriptor) => {
                if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.route')) return;
                hostApi.registerRoute(TuiPluginRouteDescriptorSchema.parse(descriptor));
                refreshSignals();
            },
            registerCommand: (descriptor: TuiPluginCommandDescriptor, handler?: TuiPluginCommandHandler) => {
                if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.command')) return;
                const parsed = TuiPluginCommandDescriptorSchema.parse(descriptor);
                const handle = hostApi.registerCommand(parsed);
                if (handler !== undefined) {
                    registeredCommands.set(parsed.id, { pluginName: manifest.name, handler, dispose: handle.dispose });
                }
                refreshSignals();
            },
            kv: Object.freeze({
                getString: (key: string) =>
                    hasCapability(hostApi.capabilities, 'ui.kv')
                        ? input.kvStore.getString(namespace, key)
                        : Promise.resolve(undefined),
                setString: async (key: string, value: string) => {
                    if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.kv')) return;
                    await input.kvStore.setEntry(namespace, { key, schemaKey: 'string', value });
                },
                delete: async (key: string) => {
                    if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.kv')) return;
                    await input.kvStore.deleteEntry(namespace, key);
                },
            }),
            dialog: Object.freeze({
                open: (descriptor) =>
                    requireCapability(manifest.name, hostApi.capabilities, 'ui.dialog')
                        ? input.dialog.open(descriptor)
                        : () => {},
                close: input.dialog.close,
                cancel: input.dialog.cancel,
            }),
            route: Object.freeze({
                current: input.route.current,
                setRoute: (route) => {
                    if (!requireCapability(manifest.name, hostApi.capabilities, 'ui.route')) return;
                    input.route.setRoute(route);
                },
                resetRoute: input.route.resetRoute,
            }),
            theme: Object.freeze({
                preference: input.theme.preference,
                savePreference: (preference) =>
                    requireCapability(manifest.name, hostApi.capabilities, 'ui.theme')
                        ? input.theme.savePreference(preference)
                        : Promise.resolve({ kind: 'invalid-preference' as const }),
            }),
        };
        return Object.freeze(api);
    }

    function hasCapability(capabilities: readonly TuiPluginCapabilityId[], capability: TuiPluginCapabilityId): boolean {
        return capabilities.includes(capability);
    }

    function requireCapability(
        pluginName: string,
        capabilities: readonly TuiPluginCapabilityId[],
        capability: TuiPluginCapabilityId,
    ): boolean {
        if (hasCapability(capabilities, capability)) return true;
        recordDiagnostic(
            diagnostic(pluginName, 'warning', 'capability_required', `Capability required: ${capability}`),
        );
        return false;
    }

    async function dispatchCommand(commandId: string): Promise<TuiPluginDispatchResult> {
        const command = registeredCommands.get(commandId);
        if (command === undefined) return { kind: 'missing' };
        try {
            await command.handler();
            return { kind: 'handled' };
        } catch (error: unknown) {
            if (error instanceof Error) {
                await reportFailure(command.pluginName, 'plugin_callback_failed', error.message);
            } else {
                await reportFailure(command.pluginName, 'plugin_callback_failed', 'Plugin callback failed');
            }
            command.dispose();
            registeredCommands.delete(commandId);
            refreshSignals();
            return { kind: 'failed' };
        }
    }

    async function reportFailure(pluginName: string, code: string, message: string): Promise<void> {
        await recordDiagnostics([diagnostic(pluginName, 'error', code, message)]);
        input.toast.show(`Plugin ${pluginName} failed`, 'error');
    }

    function diagnostic(
        pluginName: string,
        level: TuiPluginDiagnostic['level'],
        code: string,
        message: string,
    ): TuiPluginDiagnostic {
        return TuiPluginDiagnosticSchema.parse({
            pluginName,
            level,
            code,
            message,
            redacted: true,
            timestamp: input.now(),
        });
    }

    function recordDiagnostic(diagnosticValue: TuiPluginDiagnostic): void {
        setDiagnostics((current) => [...current, diagnosticValue]);
        void input.manifestStore.appendDiagnostic(diagnosticValue);
    }

    async function recordDiagnostics(values: readonly TuiPluginDiagnostic[]): Promise<void> {
        for (const value of values) {
            const parsed = TuiPluginDiagnosticSchema.parse(value);
            recordDiagnostic(parsed);
        }
    }

    function refreshSignals(): void {
        setSlots(input.registry.listSlots());
        setRoutes(input.registry.listRoutes());
        setCommands(input.registry.listCommands());
    }

    return Object.freeze({ slots, routes, commands, diagnostics, ready, dispatchCommand });
}
