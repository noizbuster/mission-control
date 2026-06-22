/**
 * Plugin path resolution.
 *
 * Plugins live at `~/.gctrl/plugins/{name}/`. The plugin home (`~/.gctrl/`)
 * is resolved via: `GCTRL_HOME` env var → `~/.gctrl/` (via `os.homedir()`).
 *
 * This is a SEPARATE namespace from `MCTRL_CONFIG_DIR` — plugins use their own
 * home so plugin installations do not collide with skill/workflow config.
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const pluginHomeEnvKey = 'GCTRL_HOME';
const PLUGIN_HOME_DIR_NAME = '.gctrl';
const PLUGINS_DIR_NAME = 'plugins';

/**
 * Resolve the plugin home directory.
 *
 * Precedence: `envOverride` param → `GCTRL_HOME` env var → `~/.gctrl/`.
 * Throws if the home directory cannot be resolved (homedir() returned empty).
 */
export function resolvePluginHome(envOverride?: string): string {
    if (envOverride !== undefined && envOverride.length > 0) {
        return envOverride;
    }
    const envHome = process.env[pluginHomeEnvKey];
    if (envHome !== undefined && envHome.length > 0) {
        return envHome;
    }
    const home = homedir();
    if (home.length === 0) {
        throw new Error('cannot resolve plugin home: os.homedir() returned an empty string');
    }
    return join(home, PLUGIN_HOME_DIR_NAME);
}

/**
 * Resolve a plugin directory: `{pluginHome}/plugins/{name}/`.
 *
 * If `home` is omitted, it is resolved via {@link resolvePluginHome}.
 */
export function resolvePluginDir(name: string, home?: string): string {
    const base = home ?? resolvePluginHome();
    return join(base, PLUGINS_DIR_NAME, name);
}

/**
 * Ensure the plugin home (`~/.gctrl/`) and plugins subdirectory
 * (`~/.gctrl/plugins/`) exist. Creates them recursively if missing.
 *
 * Returns the plugins directory path.
 */
export async function ensurePluginDirs(): Promise<string> {
    const home = resolvePluginHome();
    const pluginsDir = join(home, PLUGINS_DIR_NAME);
    await mkdir(pluginsDir, { recursive: true });
    return pluginsDir;
}
