/**
 * SKILL.md discovery + frontmatter loader.
 *
 * Multi-scope, first-wins-by-name discovery (omo/opencode hybrid), in priority
 * order (each scope is searched recursively for SKILL.md files):
 *   1. global  `<user-config-dir>/skills/`  (MCTRL_CONFIG_DIR / XDG_CONFIG_HOME / ~/.config/mission-control)
 *   2. project `<workspace>/.mctrl/skills/`
 *   3. project `<workspace>/.agents/skills/`
 *
 * The first scope to claim a name wins; later duplicates are skipped with a
 * diagnostic (never a throw). A SKILL.md is pure DATA: its body is read as text
 * and never evaluated, imported, or injected into the system prompt here (todo 9
 * owns on-demand body loading).
 *
 * Trust/denylist stance: project scans are skipped entirely when the workspace
 * root itself sits inside a denylisted path (e.g. `temp/ref-repos/**`), and the
 * recursive walker prunes denylisted directory segments and refuses to follow
 * symlinks (escape defense). This reuses the read-tools denylist so the same
 * `temp/ref-repos` / generated-dir guard covers skill discovery.
 */
import { appName } from '@mission-control/config';
import { parse as parseYaml } from 'yaml';
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from '../tools/read-tools-paths.js';
import { type SkillMetadata, SkillMetadataSchema, validateSkillMetadata } from './skill-metadata.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Env override for the user config directory (parity with the MCP config loader). */
export const skillsConfigDirEnvKey = 'MCTRL_CONFIG_DIR';
const windowsAppDataEnvKey = 'APPDATA';
const xdgConfigHomeEnvKey = 'XDG_CONFIG_HOME';

const FRONTMATTER_DELIMITER = '---';
/** Skip SKILL.md files larger than this (size bound — DATA only, but cap abuse). */
export const DEFAULT_MAX_SKILL_FILE_BYTES = 64 * 1024;
/** Hard cap on total discovered skills across all scopes. */
export const DEFAULT_MAX_SKILLS = 256;
/** Max recursive walk depth under a scope root. */
const MAX_WALK_DEPTH = 10;

/** Denylist roots expressed as absolute-path needles (multi-segment aware). */
const denylistAbsolutePathNeedles: readonly string[] = defaultReadOnlyRepoToolDenylist.map((entry) =>
    entry.toLowerCase(),
);
/** Single-segment denylist dir names, used to prune the walk cheaply. */
const denylistDirNameSet: ReadonlySet<string> = new Set(
    defaultReadOnlyRepoToolDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

export type SkillScope = 'user' | 'project';

export type SkillScopeId = 'global-user' | 'project-mctrl' | 'project-agents' | 'project-plugin';

export type SkillSourceInfo = {
    readonly scope: SkillScope;
    readonly scopeId: SkillScopeId;
    /** Absolute path of the scope root the skill was discovered under. */
    readonly sourceDir: string;
};

/**
 * A discovered skill handle. `description` and `disableModelInvocation` are
 * always present (defaulted) so downstream consumers (todo 9 `<available_skills>`)
 * never deal with undefined. `filePath` is the absolute SKILL.md path; `baseDir`
 * is its containing directory.
 */
export type Skill = {
    readonly name: string;
    readonly description: string;
    readonly disableModelInvocation: boolean;
    readonly filePath: string;
    readonly baseDir: string;
    readonly sourceInfo: SkillSourceInfo;
};

export type SkillDiscoveryDiagnostic = {
    readonly level: 'warning';
    readonly filePath: string;
    readonly scopeId: SkillScopeId;
    readonly message: string;
};

export type DiscoverSkillsOptions = {
    readonly workspaceRoot: string;
    /** Override the global user config directory (testing/injection). */
    readonly userConfigDir?: string;
    /** Override env (testing). Defaults to `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxSkillFileBytes?: number;
    readonly maxSkills?: number;
    /**
     * Additional directories to scan for SKILL.md files after the three standard
     * scopes (global-user, project-mctrl, project-agents). First-wins by name
     * applies across all scopes, so a skill found in a standard scope shadows
     * one found here. Used to wire plugin-provided skill directories.
     */
    readonly additionalSkillDirs?: readonly string[];
};

export type DiscoverSkillsResult = {
    readonly skills: readonly Skill[];
    readonly diagnostics: readonly SkillDiscoveryDiagnostic[];
};

export type ParsedSkillFile = {
    readonly data: SkillMetadata;
    readonly body: string;
};

export type FrontmatterParseOutcome =
    | { readonly ok: true; readonly data: SkillMetadata; readonly body: string }
    | { readonly ok: false; readonly error: string };

/**
 * Resolve the global user config directory using the same precedence as the MCP
 * config loader: `userConfigDir` override → `MCTRL_CONFIG_DIR` → `XDG_CONFIG_HOME`
 * → platform default (`~/.config/mission-control` on unix, `%APPDATA%\mission-control`
 * on Windows).
 */
export function resolveUserConfigDir(
    options: { readonly userConfigDir?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): string {
    if (options.userConfigDir !== undefined) {
        return options.userConfigDir;
    }
    const env = options.env ?? process.env;
    const override = env[skillsConfigDirEnvKey];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    const homeDir = homedir();
    const platform = process.platform;
    if (platform === 'win32') {
        const appData = env[windowsAppDataEnvKey];
        const configHome = appData !== undefined && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming');
        return join(configHome, appName);
    }
    const xdgConfigHome = env[xdgConfigHomeEnvKey];
    const configHome =
        xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homeDir, '.config');
    return join(configHome, appName);
}

/**
 * Parse a SKILL.md file's contents into frontmatter metadata + markdown body.
 *
 * Format:
 * ```
 * ---
 * name: my-skill
 * description: ...
 * ---
 * <markdown body>
 * ```
 *
 * Defensive: malformed YAML, missing fences, or schema-invalid metadata yield
 * `{ ok: false, error }` — the caller skips the file with a diagnostic. The body
 * is returned verbatim as inert text; it is never evaluated here.
 */
export function parseSkillFrontmatter(contents: string): FrontmatterParseOutcome {
    const text = stripBom(contents);
    const lines = text.split(/\r?\n/);
    const firstLine = lines[0];
    if (firstLine === undefined || firstLine.trim() !== FRONTMATTER_DELIMITER) {
        return { ok: false, error: 'missing YAML frontmatter opening fence (---)' };
    }
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i += 1) {
        const candidate = lines[i];
        if (candidate !== undefined && candidate.trim() === FRONTMATTER_DELIMITER) {
            closeIdx = i;
            break;
        }
    }
    if (closeIdx === -1) {
        return { ok: false, error: 'missing YAML frontmatter closing fence (---)' };
    }
    const yamlText = lines.slice(1, closeIdx).join('\n');
    const body = lines.slice(closeIdx + 1).join('\n');

    let parsed: unknown;
    try {
        parsed = parseYaml(yamlText);
    } catch (error: unknown) {
        return { ok: false, error: `YAML parse failed: ${instanceMessage(error)}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'frontmatter must be a YAML mapping (object), not a scalar or sequence' };
    }
    const validated = validateSkillMetadata(parsed);
    if (!validated.ok) {
        return { ok: false, error: validated.error };
    }
    return { ok: true, data: validated.data, body };
}

type ScopeDescriptor = {
    readonly scopeId: SkillScopeId;
    readonly scope: SkillScope;
    readonly dir: string;
    readonly skipped: boolean;
    readonly skipReason?: string;
};

/**
 * Discover skills across all scopes, first-wins by name in priority order.
 * Never throws: malformed files, oversized files, and duplicates produce
 * diagnostics and are skipped.
 */
export async function discoverSkills(options: DiscoverSkillsOptions): Promise<DiscoverSkillsResult> {
    const maxFileBytes = options.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES;
    const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
    const diagnostics: SkillDiscoveryDiagnostic[] = [];
    const skills: Skill[] = [];
    const seenNames = new Set<string>();
    const workspaceRootDenied = absolutePathMatchesDenylist(options.workspaceRoot);

    for (const scope of resolveScopeDescriptors(options, workspaceRootDenied)) {
        if (scope.skipped) {
            continue;
        }
        const candidates = await walkSkillFiles(scope.dir);
        for (const filePath of candidates) {
            const skip = await tryLoadSkillFile(filePath, scope, maxFileBytes);
            if (skip.kind === 'diagnostic') {
                diagnostics.push(skip.diagnostic);
                continue;
            }
            if (skip.kind === 'drop') {
                continue;
            }
            const loaded = skip.loaded;
            if (seenNames.has(loaded.data.name)) {
                diagnostics.push({
                    level: 'warning',
                    filePath,
                    scopeId: scope.scopeId,
                    message: `skipped: skill '${loaded.data.name}' already discovered (first-wins)`,
                });
                continue;
            }
            if (skills.length >= maxSkills) {
                diagnostics.push({
                    level: 'warning',
                    filePath,
                    scopeId: scope.scopeId,
                    message: `skipped: max skills limit (${maxSkills}) reached`,
                });
                continue;
            }
            seenNames.add(loaded.data.name);
            skills.push({
                name: loaded.data.name,
                description: loaded.data.description ?? '',
                disableModelInvocation: loaded.data.disableModelInvocation ?? false,
                filePath,
                baseDir: dirname(filePath),
                sourceInfo: { scope: scope.scope, scopeId: scope.scopeId, sourceDir: scope.dir },
            });
        }
    }

    return { skills, diagnostics };
}

type FileLoadOutcome =
    | { readonly kind: 'loaded'; readonly loaded: ParsedSkillFile }
    | { readonly kind: 'diagnostic'; readonly diagnostic: SkillDiscoveryDiagnostic }
    | { readonly kind: 'drop' };

async function tryLoadSkillFile(
    filePath: string,
    scope: ScopeDescriptor,
    maxFileBytes: number,
): Promise<FileLoadOutcome> {
    if (absolutePathMatchesDenylist(filePath)) {
        return diagnostic(filePath, scope.scopeId, 'skipped: path matches the discovery denylist');
    }
    let fileStats: { readonly size: number };
    try {
        fileStats = await stat(filePath);
    } catch {
        return { kind: 'drop' };
    }
    if (fileStats.size > maxFileBytes) {
        return diagnostic(
            filePath,
            scope.scopeId,
            `skipped: file exceeds size bound (${fileStats.size} > ${maxFileBytes} bytes)`,
        );
    }
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        return diagnostic(filePath, scope.scopeId, `skipped: read failed: ${instanceMessage(error)}`);
    }
    const parsed = parseSkillFrontmatter(contents);
    if (!parsed.ok) {
        return diagnostic(filePath, scope.scopeId, parsed.error);
    }
    return { kind: 'loaded', loaded: { data: parsed.data, body: parsed.body } };
}

function diagnostic(filePath: string, scopeId: SkillScopeId, message: string): FileLoadOutcome {
    return { kind: 'diagnostic', diagnostic: { level: 'warning', filePath, scopeId, message } };
}

function resolveScopeDescriptors(
    options: DiscoverSkillsOptions,
    workspaceRootDenied: boolean,
): readonly ScopeDescriptor[] {
    const scopes: ScopeDescriptor[] = [];
    const globalDir = join(
        resolveUserConfigDir({
            ...(options.userConfigDir !== undefined ? { userConfigDir: options.userConfigDir } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
        }),
        'skills',
    );
    scopes.push({ scopeId: 'global-user', scope: 'user', dir: globalDir, skipped: false });
    if (workspaceRootDenied) {
        scopes.push({
            scopeId: 'project-mctrl',
            scope: 'project',
            dir: join(options.workspaceRoot, '.mctrl', 'skills'),
            skipped: true,
            skipReason: 'workspace root is inside a denylisted path',
        });
        scopes.push({
            scopeId: 'project-agents',
            scope: 'project',
            dir: join(options.workspaceRoot, '.agents', 'skills'),
            skipped: true,
            skipReason: 'workspace root is inside a denylisted path',
        });
    } else {
        scopes.push({
            scopeId: 'project-mctrl',
            scope: 'project',
            dir: join(options.workspaceRoot, '.mctrl', 'skills'),
            skipped: false,
        });
        scopes.push({
            scopeId: 'project-agents',
            scope: 'project',
            dir: join(options.workspaceRoot, '.agents', 'skills'),
            skipped: false,
        });
    }
    for (const dir of options.additionalSkillDirs ?? []) {
        scopes.push({ scopeId: 'project-plugin', scope: 'project', dir, skipped: false });
    }
    return scopes;
}

/**
 * Bounded recursive walk for `SKILL.md` files under a scope root.
 * Skips symlinked directories (escape defense) and denylisted directory names.
 */
async function walkSkillFiles(scopeRoot: string): Promise<readonly string[]> {
    const results: string[] = [];
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: scopeRoot, depth: 0 }];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined || item.depth > MAX_WALK_DEPTH) {
            continue;
        }
        let entries: readonly Dirent[];
        try {
            entries = await readdir(item.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const fullPath = join(item.dir, entry.name);
            if (entry.isDirectory()) {
                if (denylistDirNameSet.has(entry.name.toLowerCase())) {
                    continue;
                }
                queue.push({ dir: fullPath, depth: item.depth + 1 });
                continue;
            }
            if (entry.isFile() && entry.name === 'SKILL.md') {
                results.push(fullPath);
            }
        }
    }
    return results.sort();
}

/**
 * True if an absolute path intersects a denylisted path (multi-segment aware).
 * Catches both `temp/ref-repos/...` and workspace roots nested inside it.
 */
function absolutePathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return denylistAbsolutePathNeedles.some((needle) => {
        if (needle.length === 0) {
            return false;
        }
        return posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`);
    });
}

function stripBom(value: string): string {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Re-export for callers that want the schema directly from this module surface.
export { SkillMetadataSchema };
