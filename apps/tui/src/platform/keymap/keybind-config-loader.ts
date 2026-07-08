/**
 * Rebindable keybind config loader (T17).
 *
 * Sync, 3-scope, first-valid-wins discovery of a user `keybinds.json`, mirroring
 * the skill-loader's safety contract (symlink defense, size bound, never
 * throws, diagnostics). Loaded at keymap-build time by `createKeymapInstance`
 * (T1) and at `/hotkeys` + `/help` render time so the runtime keymap AND the
 * displayed shortcut reference are BOTH config-driven from the `keybind.ts`
 * registry.
 *
 * Scope priority (first-valid non-symlink file within the size bound wins,
 * matching mctrl's skill/workflow discovery):
 *   1. global  `<user-config-dir>/keybinds.json`  (MCTRL_CONFIG_DIR / XDG / platform default)
 *   2. project `<workspace>/.mctrl/keybinds.json`
 *   3. project `<workspace>/.agents/keybinds.json`
 *
 * Why SYNC (the skill-loader is async): `createKeymapInstance` is a synchronous
 * `useMemo`-driven constructor that cannot await; `runHotkeysAction` is async
 * but a single small JSON read on a user-triggered slash command has no latency
 * concern. `node:fs` sync calls mirror the skill-loader's safety (never throws,
 * diagnostics) without its async recursive walk (the loader targets a single
 * known filename per scope, not a recursive SKILL.md walk).
 *
 * Never throws: malformed JSON, unknown keys, wrong-type values, symlinks, and
 * oversized files each produce a diagnostic and are skipped — the loader always
 * returns a `KeybindOverrides` object (possibly empty).
 */
// allow: SIZE_OK — single cohesive safe-config-loader (3-scope discovery +
// never-throws validation + path/mtime cache). The T17 file lane permits only
// `keybind-config-loader.*`, so the cache/validation cannot move to a sibling.
import { appName } from '@mission-control/config';
import {
    type BindingItem,
    type BindingValue,
    Definitions,
    type KeybindName,
    type KeybindOverrides,
    Keybinds,
    unknownKeys,
} from './keybind.js';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The config filename searched for in every scope. */
export const KEYBIND_CONFIG_FILENAME = 'keybinds.json';

const configDirEnvKey = 'MCTRL_CONFIG_DIR';
const windowsAppDataEnvKey = 'APPDATA';
const xdgConfigHomeEnvKey = 'XDG_CONFIG_HOME';

/** Skip config files larger than this (size bound, DATA-only but cap abuse). */
export const DEFAULT_MAX_KEYBIND_FILE_BYTES = 64 * 1024;

export type KeybindConfigScope = 'global-user' | 'project-mctrl' | 'project-agents';

export type KeybindConfigDiagnostic = {
    readonly level: 'warning';
    readonly scope: KeybindConfigScope;
    readonly filePath: string;
    readonly message: string;
};

export type LoadKeybindConfigOptions = {
    /** Workspace root for the `.mctrl/` and `.agents/` project scopes. Defaults to `process.cwd()`. */
    readonly workspaceRoot?: string;
    /** Override the global user config directory (testing/injection). */
    readonly userConfigDir?: string;
    /** Override env (testing). Defaults to `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxFileBytes?: number;
};

export type LoadKeybindConfigResult = {
    readonly overrides: KeybindOverrides;
    readonly diagnostics: readonly KeybindConfigDiagnostic[];
    /** Absolute path of the winning config file, or `null` when none was found. */
    readonly sourcePath: string | null;
};

export type ResolveKeybindConfigResult = {
    readonly keybinds: ReturnType<typeof Keybinds.parse>;
    readonly diagnostics: readonly KeybindConfigDiagnostic[];
    readonly sourcePath: string | null;
};

type ScopeDescriptor = {
    readonly scope: KeybindConfigScope;
    readonly filePath: string;
};

/**
 * Resolve the global user config directory using the same precedence as the
 * skill loader and MCP config loader: `userConfigDir` -> `MCTRL_CONFIG_DIR` ->
 * `XDG_CONFIG_HOME` -> platform default (`~/.config/mission-control` on unix,
 * `%APPDATA%\mission-control` on Windows).
 */
export function resolveKeybindConfigDir(
    options: { readonly userConfigDir?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): string {
    if (options.userConfigDir !== undefined) {
        return options.userConfigDir;
    }
    const env = options.env ?? process.env;
    const override = env[configDirEnvKey];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    const homeDir = homedir();
    if (process.platform === 'win32') {
        const appData = env[windowsAppDataEnvKey];
        const configHome = appData !== undefined && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming');
        return join(configHome, appName);
    }
    const xdgConfigHome = env[xdgConfigHomeEnvKey];
    const configHome =
        xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homeDir, '.config');
    return join(configHome, appName);
}

/** Resolve the three candidate config paths in priority order (global first). */
function resolveScopePaths(options: LoadKeybindConfigOptions): readonly ScopeDescriptor[] {
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    const globalDir = resolveKeybindConfigDir({
        ...(options.userConfigDir !== undefined ? { userConfigDir: options.userConfigDir } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
    });
    return [
        { scope: 'global-user', filePath: join(globalDir, KEYBIND_CONFIG_FILENAME) },
        { scope: 'project-mctrl', filePath: join(workspaceRoot, '.mctrl', KEYBIND_CONFIG_FILENAME) },
        { scope: 'project-agents', filePath: join(workspaceRoot, '.agents', KEYBIND_CONFIG_FILENAME) },
    ];
}

/**
 * Validate that a raw JSON value is a legal `BindingValue` shape WITHOUT
 * throwing. Mirrors `keybind.ts#decodeBindingValue` but returns `undefined`
 * (skip) instead of throwing on a wrong type, so one bad entry does not sink
 * the whole file.
 */
function checkBindingValue(value: unknown): BindingValue | undefined {
    if (value === false || value === 'none' || typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const items: BindingItem[] = [];
        for (const item of value) {
            const checked = checkBindingValue(item);
            if (checked === undefined) {
                return undefined;
            }
            // Array context narrows BindingValue to BindingItem (mirrors
            // keybind.ts#decodeBindingValue's `as readonly BindingItem[]`).
            items.push(checked as BindingItem);
        }
        return items;
    }
    if (value !== null && typeof value === 'object') {
        return value as BindingItem;
    }
    return undefined;
}

/**
 * Coerce a parsed JSON object into a `KeybindOverrides`, dropping unknown keys
 * and wrong-type values with one diagnostic per drop. Never throws.
 */
function coerceOverrides(
    parsed: object,
    scope: KeybindConfigScope,
    filePath: string,
    diagnostics: KeybindConfigDiagnostic[],
): KeybindOverrides {
    const rawRecord = parsed as Record<string, unknown>;
    for (const key of unknownKeys(parsed)) {
        diagnostics.push(mkDiagnostic(scope, filePath, `skipped unknown keybind '${key}'`));
    }
    const overrides: Partial<Record<KeybindName, BindingValue>> = {};
    for (const name of Object.keys(Definitions) as KeybindName[]) {
        const rawValue = rawRecord[name];
        if (rawValue === undefined) {
            continue;
        }
        const checked = checkBindingValue(rawValue);
        if (checked === undefined) {
            diagnostics.push(mkDiagnostic(scope, filePath, `skipped '${name}': invalid value type`));
            continue;
        }
        overrides[name] = checked;
    }
    return overrides;
}

function mkDiagnostic(scope: KeybindConfigScope, filePath: string, message: string): KeybindConfigDiagnostic {
    return { level: 'warning', scope, filePath, message };
}

type ScopeOutcome =
    | { readonly kind: 'empty' }
    | { readonly kind: 'diagnostic'; readonly diagnostic: KeybindConfigDiagnostic }
    | {
          readonly kind: 'loaded';
          readonly overrides: KeybindOverrides;
          readonly diagnostics: readonly KeybindConfigDiagnostic[];
          readonly sourceMtime: number;
      };

/**
 * Attempt to load a single scope's config file. `empty` = file absent (normal,
 * no diagnostic). `diagnostic` = file exists but is unusable. `loaded` = success.
 */
function loadScope(filePath: string, scope: KeybindConfigScope, maxFileBytes: number): ScopeOutcome {
    let isSymlink: boolean;
    let size: number;
    let mtimeMs: number;
    try {
        isSymlink = lstatSync(filePath).isSymbolicLink();
        const fileStat = statSync(filePath);
        size = fileStat.size;
        mtimeMs = fileStat.mtimeMs;
    } catch {
        return { kind: 'empty' };
    }
    if (isSymlink) {
        return {
            kind: 'diagnostic',
            diagnostic: mkDiagnostic(scope, filePath, 'skipped: symbolic link (escape defense)'),
        };
    }
    if (size > maxFileBytes) {
        return {
            kind: 'diagnostic',
            diagnostic: mkDiagnostic(
                scope,
                filePath,
                `skipped: file exceeds size bound (${size} > ${maxFileBytes} bytes)`,
            ),
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            kind: 'diagnostic',
            diagnostic: mkDiagnostic(scope, filePath, `skipped: read/parse failed: ${reason}`),
        };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            kind: 'diagnostic',
            diagnostic: mkDiagnostic(
                scope,
                filePath,
                'skipped: top-level value must be a JSON object (keybind -> binding)',
            ),
        };
    }
    const diagnostics: KeybindConfigDiagnostic[] = [];
    const overrides = coerceOverrides(parsed, scope, filePath, diagnostics);
    return { kind: 'loaded', overrides, diagnostics, sourceMtime: mtimeMs };
}

/**
 * Load the resolved keybind config across all scopes (first-valid-wins,
 * accumulating diagnostics from malformed higher-priority scopes). Never
 * throws. Cached per (options fingerprint, resolved source path, file mtime)
 * so repeated `/hotkeys` invocations do not re-read the file; the cache
 * invalidates when the resolved path or the file mtime changes.
 */
export function loadKeybindConfig(options: LoadKeybindConfigOptions = {}): LoadKeybindConfigResult {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_KEYBIND_FILE_BYTES;
    const fingerprint = `${options.userConfigDir ?? ''}|${options.workspaceRoot ?? process.cwd()}`;
    const scopes = resolveScopePaths(options);
    const diagnostics: KeybindConfigDiagnostic[] = [];

    for (const candidate of scopes) {
        if (!existsSync(candidate.filePath)) {
            continue;
        }
        const cached = readCache(fingerprint, candidate.filePath);
        if (cached !== null) {
            return cached;
        }
        const outcome = loadScope(candidate.filePath, candidate.scope, maxFileBytes);
        if (outcome.kind === 'empty') {
            continue;
        }
        if (outcome.kind === 'diagnostic') {
            // Malformed higher-priority scope: record and fall through to the
            // next scope (first-VALID-wins).
            diagnostics.push(outcome.diagnostic);
            continue;
        }
        diagnostics.push(...outcome.diagnostics);
        const result: LoadKeybindConfigResult = {
            overrides: outcome.overrides,
            diagnostics: [...diagnostics],
            sourcePath: candidate.filePath,
        };
        writeCache(fingerprint, candidate.filePath, outcome.sourceMtime, result);
        return result;
    }

    return { overrides: {}, diagnostics: [...diagnostics], sourcePath: null };
}

/**
 * Load the config and merge overrides onto the catalog defaults via
 * `Keybinds.parse`. Never throws: overrides are pre-coerced (unknown keys and
 * wrong-type values already stripped by {@link loadKeybindConfig}), so `parse`
 * receives only known keys with valid shapes.
 */
export function resolveKeybindConfig(options: LoadKeybindConfigOptions = {}): ResolveKeybindConfigResult {
    const { overrides, diagnostics, sourcePath } = loadKeybindConfig(options);
    const keybinds = Keybinds.parse(overrides);
    return { keybinds, diagnostics, sourcePath };
}

// ---------------------------------------------------------------------------
// Cache (fingerprint + path + mtime keyed; invalidates on path or content change)
// ---------------------------------------------------------------------------

type CacheEntry = {
    readonly fingerprint: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly result: LoadKeybindConfigResult;
};

let cache: CacheEntry | null = null;

function readCache(fingerprint: string, filePath: string): LoadKeybindConfigResult | null {
    if (cache === null || cache.fingerprint !== fingerprint || cache.filePath !== filePath) {
        return null;
    }
    try {
        if (statSync(filePath).mtimeMs === cache.mtimeMs) {
            return cache.result;
        }
    } catch {
        return null;
    }
    return null;
}

function writeCache(fingerprint: string, filePath: string, mtimeMs: number, result: LoadKeybindConfigResult): void {
    cache = { fingerprint, filePath, mtimeMs, result };
}

/** Reset the loader cache. Tests call this between cases for deterministic FS reads. */
export function clearKeybindConfigCache(): void {
    cache = null;
}
