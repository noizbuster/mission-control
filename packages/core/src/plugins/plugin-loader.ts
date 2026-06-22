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
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from '../tools/read-tools-paths.js';
import { stripJsoncComments } from '../workflows/jsonc-parser.js';
import { pluginHomeEnvKey, resolvePluginHome } from './plugin-paths.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_MAX_PLUGIN_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_PLUGINS = 256;
const MANIFEST_FILENAME = 'plugin.json';
const PLUGINS_DIR_NAME = 'plugins';

const denylistAbsolutePathNeedles: readonly string[] = defaultReadOnlyRepoToolDenylist.map((entry) =>
    entry.toLowerCase(),
);
const denylistDirNameSet: ReadonlySet<string> = new Set(
    defaultReadOnlyRepoToolDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

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
        if (denylistDirNameSet.has(entry.name.toLowerCase())) {
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
    if (absolutePathMatchesDenylist(manifestPath)) {
        throw new Error(`plugin manifest path matches denylist: ${pluginDir}`);
    }
    let stats: { readonly size: number };
    try {
        stats = await stat(manifestPath);
    } catch {
        throw new Error(`plugin manifest not found: ${manifestPath}`);
    }
    if (stats.size > DEFAULT_MAX_PLUGIN_FILE_BYTES) {
        throw new Error(
            `plugin manifest exceeds size bound (${stats.size} > ${DEFAULT_MAX_PLUGIN_FILE_BYTES} bytes): ${manifestPath}`,
        );
    }
    const contents = await readFile(manifestPath, 'utf8');
    const stripped = stripJsoncComments(contents);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error: unknown) {
        throw new Error(`plugin manifest JSON parse failed: ${instanceMessage(error)}`);
    }
    const result = PluginManifestSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new Error(`plugin manifest validation failed: ${issues}`);
    }
    return result.data;
}

async function tryLoadPluginManifest(
    pluginDir: string,
    dirName: string,
    maxFileBytes: number,
): Promise<FileLoadOutcome> {
    const manifestPath = join(pluginDir, MANIFEST_FILENAME);
    if (absolutePathMatchesDenylist(manifestPath)) {
        return diagnostic(dirName, 'warning', 'denylisted', `path matches the discovery denylist`, pluginDir);
    }
    let stats: { readonly size: number };
    try {
        stats = await stat(manifestPath);
    } catch {
        return { kind: 'drop' };
    }
    if (stats.size > maxFileBytes) {
        return diagnostic(
            dirName,
            'warning',
            'size_exceeded',
            `manifest exceeds size bound (${stats.size} > ${maxFileBytes} bytes)`,
            manifestPath,
        );
    }
    let contents: string;
    try {
        contents = await readFile(manifestPath, 'utf8');
    } catch (error: unknown) {
        return diagnostic(dirName, 'error', 'read_failed', `read failed: ${instanceMessage(error)}`, manifestPath);
    }
    const stripped = stripJsoncComments(contents);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error: unknown) {
        return diagnostic(
            dirName,
            'error',
            'parse_error',
            `JSON parse failed: ${instanceMessage(error)}`,
            manifestPath,
        );
    }
    const result = PluginManifestSchema.safeParse(parsed);
    if (!result.success) {
        const name = readNameField(parsed, dirName);
        const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        return diagnostic(name, 'error', 'validation_error', `schema validation failed: ${issues}`, manifestPath);
    }
    return { kind: 'loaded', manifest: result.data };
}

function diagnostic(
    pluginName: string,
    severity: 'error' | 'warning',
    code: string,
    message: string,
    path: string,
): FileLoadOutcome {
    return { kind: 'diagnostic', diagnostic: { pluginName, severity, code, message, path } };
}

function resolvePluginHomeFromOptions(options: DiscoverPluginsOptions): string {
    if (options.pluginHome !== undefined) {
        return options.pluginHome;
    }
    const gctrlHomeFromEnv = options.env?.[pluginHomeEnvKey];
    return resolvePluginHome(gctrlHomeFromEnv);
}

function absolutePathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return denylistAbsolutePathNeedles.some((needle) => {
        if (needle.length === 0) {
            return false;
        }
        return posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`);
    });
}

function readNameField(value: unknown, fallback: string): string {
    if (typeof value === 'object' && value !== null && 'name' in value) {
        const candidate = (value as { readonly name?: unknown }).name;
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return fallback;
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
