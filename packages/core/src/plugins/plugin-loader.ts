/**
 * Plugin discovery: scans each subdirectory of `{pluginHome}/plugins/` for a
 * `plugin.json` manifest.
 *
 * Mirrors `discoverSkills`/`discoverWorkflows`: denylist reuse, symlink defense,
 * size cap (64KB manifest), plugin cap (256), never throws — broken plugins
 * produce diagnostics and are skipped.
 *
 * Key difference from skill/workflow discovery: plugins are ONE level deep.
 * Each subdirectory of `plugins/` is a potential plugin; `plugin.json` is the
 * manifest. The manager reads subdirectory contents (skills/, workflows/,
 * categories/*.json, etc.) lazily after discovery.
 */
import {
    type PluginDescriptor,
    type PluginDiscoveryDiagnostic,
    type PluginManifest,
    PluginManifestSchema,
} from '@mission-control/protocol';
import { absolutePathMatchesDenylist, manifestDenylistDirNames } from '../discovery/index';
import { type JsoncLoadFailure, jsoncDiagnosticFields, loadJsoncResource } from '../discovery/load-jsonc';
import { errorToString } from '../util/error-to-string';
import { pluginHomeEnvKey, resolvePluginHome } from './plugin-paths';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const DEFAULT_MAX_PLUGIN_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_PLUGINS = 256;
const MANIFEST_FILENAME = 'plugin.json';
const PLUGINS_DIR_NAME = 'plugins';

export type DiscoverPluginsOptions = {
    readonly pluginHome?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxPluginFileBytes?: number;
    readonly maxPlugins?: number;
};

export type DiscoverPluginsResult = {
    readonly plugins: readonly PluginDescriptor[];
    readonly diagnostics: readonly PluginDiscoveryDiagnostic[];
};

type FileLoadOutcome =
    | { readonly kind: 'loaded'; readonly manifest: PluginManifest }
    | { readonly kind: 'diagnostic'; readonly diagnostic: PluginDiscoveryDiagnostic }
    | { readonly kind: 'drop' };

/**
 * Discover all plugins under `{pluginHome}/plugins/`. Never throws.
 *
 * Broken manifests, oversized files, denylisted paths, and symlinks produce
 * diagnostics and are skipped. First-wins by plugin name (manifest `name` field).
 */
export async function discoverPlugins(options: DiscoverPluginsOptions = {}): Promise<DiscoverPluginsResult> {
    const maxFileBytes = options.maxPluginFileBytes ?? DEFAULT_MAX_PLUGIN_FILE_BYTES;
    const maxPlugins = options.maxPlugins ?? DEFAULT_MAX_PLUGINS;
    const diagnostics: PluginDiscoveryDiagnostic[] = [];
    const plugins: PluginDescriptor[] = [];
    const seenNames = new Set<string>();

    const pluginHome = resolvePluginHomeFromOptions(options);
    if (absolutePathMatchesDenylist(pluginHome)) {
        return { plugins, diagnostics };
    }
    const pluginsDir = join(pluginHome, PLUGINS_DIR_NAME);

    let entries: readonly Dirent[];
    try {
        entries = await readdir(pluginsDir, { withFileTypes: true });
    } catch {
        return { plugins, diagnostics };
    }

    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (!entry.isDirectory()) {
            continue;
        }
        if (manifestDenylistDirNames.has(entry.name.toLowerCase())) {
            continue;
        }
        const pluginDir = join(pluginsDir, entry.name);
        if (absolutePathMatchesDenylist(pluginDir)) {
            continue;
        }
        const outcome = await tryLoadPluginManifest(pluginDir, entry.name, maxFileBytes);
        if (outcome.kind === 'diagnostic') {
            diagnostics.push(outcome.diagnostic);
            continue;
        }
        if (outcome.kind === 'drop') {
            continue;
        }
        const manifest = outcome.manifest;
        if (seenNames.has(manifest.name)) {
            diagnostics.push({
                pluginName: manifest.name,
                severity: 'warning',
                code: 'duplicate_name',
                message: `plugin '${manifest.name}' already discovered (first-wins)`,
                path: pluginDir,
            });
            continue;
        }
        if (plugins.length >= maxPlugins) {
            diagnostics.push({
                pluginName: manifest.name,
                severity: 'warning',
                code: 'limit_reached',
                message: `max plugins limit (${maxPlugins}) reached`,
                path: pluginDir,
            });
            continue;
        }
        seenNames.add(manifest.name);
        plugins.push({ manifest, rootPath: pluginDir });
    }

    return { plugins, diagnostics };
}

/**
 * Load and validate a single plugin manifest from a plugin directory.
 *
 * Reads `{pluginDir}/plugin.json`, strips JSONC comments, parses JSON, and
 * validates against {@link PluginManifestSchema}. Throws on any failure:
 * missing file, oversized manifest, parse error, or schema validation error.
 */
export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
    const manifestPath = join(pluginDir, MANIFEST_FILENAME);
    const outcome = await loadJsoncResource<PluginManifest, JsoncLoadFailure>({
        filePath: manifestPath,
        maxFileBytes: DEFAULT_MAX_PLUGIN_FILE_BYTES,
        schema: PluginManifestSchema,
        fallbackName: basename(pluginDir),
        toDiagnostic: (failure) => ({ kind: 'diagnostic', diagnostic: failure }),
    });
    if (outcome.kind === 'loaded') {
        return outcome.data;
    }
    if (outcome.kind === 'drop') {
        throw new Error(`plugin manifest not found: ${manifestPath}`);
    }
    const failure = outcome.diagnostic;
    switch (failure.stage) {
        case 'denylisted':
            throw new Error(`plugin manifest path matches denylist: ${pluginDir}`);
        case 'size_exceeded':
            throw new Error(
                `plugin manifest exceeds size bound (${failure.size} > ${failure.maxFileBytes} bytes): ${manifestPath}`,
            );
        case 'read_failed':
            throw failure.error;
        case 'parse_error':
            throw new Error(`plugin manifest JSON parse failed: ${errorToString(failure.error)}`);
        case 'validation_error':
            throw new Error(`plugin manifest validation failed: ${failure.issues}`);
    }
}

async function tryLoadPluginManifest(
    pluginDir: string,
    dirName: string,
    maxFileBytes: number,
): Promise<FileLoadOutcome> {
    const manifestPath = join(pluginDir, MANIFEST_FILENAME);
    const outcome = await loadJsoncResource<PluginManifest, PluginDiscoveryDiagnostic>({
        filePath: manifestPath,
        maxFileBytes,
        schema: PluginManifestSchema,
        fallbackName: dirName,
        toDiagnostic: (failure) => {
            const { severity, message } = jsoncDiagnosticFields(failure, 'manifest');
            return {
                kind: 'diagnostic',
                diagnostic: {
                    pluginName: failure.name,
                    severity,
                    code: failure.stage,
                    message,
                    path: failure.stage === 'denylisted' ? pluginDir : manifestPath,
                },
            };
        },
    });
    return outcome.kind === 'loaded' ? { kind: 'loaded', manifest: outcome.data } : outcome;
}

function resolvePluginHomeFromOptions(options: DiscoverPluginsOptions): string {
    if (options.pluginHome !== undefined) {
        return options.pluginHome;
    }
    const gctrlHomeFromEnv = options.env?.[pluginHomeEnvKey];
    return resolvePluginHome(gctrlHomeFromEnv);
}
