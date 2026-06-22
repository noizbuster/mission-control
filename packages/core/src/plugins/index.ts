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
} from './plugin-loader.js';
export { PluginManager, type PluginManagerOptions } from './plugin-manager.js';
export { ensurePluginDirs, pluginHomeEnvKey, resolvePluginDir, resolvePluginHome } from './plugin-paths.js';
