/**
 * Plugins subsystem public surface: plugin path resolution, manifest discovery,
 * and the plugin manager. Re-exported from the package root.
 */

export {
    DEFAULT_MAX_PLUGIN_FILE_BYTES,
    DEFAULT_MAX_PLUGINS,
    type DiscoverPluginsOptions,
    type DiscoverPluginsResult,
    discoverPlugins,
    loadPluginManifest,
} from './plugin-loader';
export { PluginManager, type PluginManagerOptions } from './plugin-manager';
export { ensurePluginDirs, pluginHomeEnvKey, resolvePluginDir, resolvePluginHome } from './plugin-paths';
export {
    type TuiPluginHostApi,
    TuiPluginHostRegistry,
    type TuiPluginHostRegistryOptions,
    type TuiPluginLoadInput,
    type TuiPluginLoadResult,
    type TuiPluginRegistrationHandle,
    type TuiPluginSource,
} from './tui-plugin-host';
