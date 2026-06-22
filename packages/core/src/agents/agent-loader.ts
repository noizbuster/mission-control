/**
 * Agent discovery across 4 builtin scopes (project `<ws>/.mctrl/agents/`,
 * user `<cfg>/agents/`, plugin `additionalDirs`, bundled templates) plus 9
 * cross-harness providers. Discovery delegates to a {@linkcode CapabilityRegistry}:
 * the builtin 4-scope loader runs at priority 100 so mission-control's own
 * agents win name conflicts over imported ones; the 9 cross-harness importers
 * (Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub
 * Copilot, OpenCode) run at priority 50. First-wins by name across all
 * providers. Mirrors the safety patterns of `discoverWorkflows` /
 * `discoverSkills` (symlink lstat defense, denylist pruning, size bound,
 * never-throws). Broken files, symlinks, and oversized entries produce
 * diagnostics and are skipped.
 */
import { type AgentDefinition, type AgentSource } from '@mission-control/protocol';
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from '../tools/read-tools-paths.js';
import { AgentParseError, parseAgentFile } from './agent-parser.js';
import { BUNDLED_AGENT_TEMPLATES } from './bundled/index.js';
import { CapabilityRegistry } from './capability/index.js';
import type { AgentPluginProvider, LoadContext } from './capability/types.js';
import { registerBuiltinProviders } from './providers/index.js';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const DEFAULT_MAX_AGENT_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_AGENTS = 256;
const MAX_WALK_DEPTH = 10;
const AGENT_FILE_SUFFIX = '.md';
const BUNDLED_PATH = '<bundled>';

const denylistNeedles: readonly string[] = defaultReadOnlyRepoToolDenylist.map((e) => e.toLowerCase());
const denylistDirNames: ReadonlySet<string> = new Set(
    defaultReadOnlyRepoToolDenylist.filter((e) => !e.includes('/')).map((e) => e.toLowerCase()),
);

export type DiscoverAgentsOptions = {
    readonly workspaceRoot: string;
    readonly userConfigDir: string;
    readonly additionalDirs?: readonly string[];
    readonly maxFileSize?: number;
    readonly maxAgents?: number;
    readonly includeBundled?: boolean;
};

export type AgentDiscoveryDiagnostic = {
    readonly agentName: string;
    readonly severity: 'error' | 'warning' | 'info';
    readonly code: string;
    readonly message: string;
    readonly path?: string;
};

export type DiscoverAgentsResult = {
    readonly agents: readonly AgentDefinition[];
    readonly diagnostics: readonly AgentDiscoveryDiagnostic[];
};

type ScopeDescriptor = { readonly source: AgentSource; readonly dir: string; readonly skipped: boolean };

type LoadOutcome =
    | { readonly kind: 'loaded'; readonly agent: AgentDefinition }
    | { readonly kind: 'diagnostic'; readonly diagnostic: AgentDiscoveryDiagnostic }
    | { readonly kind: 'drop' };

type DiscoveryState = {
    readonly agents: AgentDefinition[];
    readonly seenNames: Set<string>;
    readonly diagnostics: AgentDiscoveryDiagnostic[];
    readonly maxAgents: number;
};

export async function discoverAgents(options: DiscoverAgentsOptions): Promise<DiscoverAgentsResult> {
    const builtinDiagnostics: AgentDiscoveryDiagnostic[] = [];

    const builtinProvider: AgentPluginProvider = {
        id: 'builtin',
        displayName: 'Mission Control',
        description: 'Project, user, plugin, and bundled agent scopes',
        priority: 100,
        async loadAgents() {
            const scanned = await scanBuiltinScopes(options);
            builtinDiagnostics.push(...scanned.diagnostics);
            return scanned.agents;
        },
    };

    const registry = new CapabilityRegistry();
    registry.registerProvider(builtinProvider);
    registerBuiltinProviders(registry);

    const ctx: LoadContext = {
        workspaceRoot: options.workspaceRoot,
        userConfigDir: options.userConfigDir,
    };
    const result = await registry.loadAll(ctx);

    return {
        agents: result.agents,
        diagnostics: [...builtinDiagnostics, ...result.diagnostics],
    };
}

async function scanBuiltinScopes(
    options: DiscoverAgentsOptions,
): Promise<{ readonly agents: readonly AgentDefinition[]; readonly diagnostics: readonly AgentDiscoveryDiagnostic[] }> {
    const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_AGENT_FILE_BYTES;
    const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    const diagnostics: AgentDiscoveryDiagnostic[] = [];
    const agents: AgentDefinition[] = [];
    const seenNames = new Set<string>();
    const wsDenied = absolutePathMatchesDenylist(options.workspaceRoot);
    const state: DiscoveryState = { agents, seenNames, diagnostics, maxAgents };

    for (const scope of resolveAgentScopes(options, wsDenied)) {
        if (scope.skipped) continue;
        for (const filePath of await walkAgentFiles(scope.dir)) {
            acceptOutcome(await tryLoadAgentFile(filePath, scope.source, maxFileSize), filePath, state);
        }
    }

    if (options.includeBundled !== false) {
        for (const template of BUNDLED_AGENT_TEMPLATES) {
            acceptOutcome(tryLoadBundledTemplate(template), BUNDLED_PATH, state);
        }
    }

    return { agents, diagnostics };
}

function acceptOutcome(outcome: LoadOutcome, path: string, state: DiscoveryState): void {
    if (outcome.kind === 'diagnostic') {
        state.diagnostics.push(outcome.diagnostic);
        return;
    }
    if (outcome.kind === 'drop') {
        return;
    }
    if (state.seenNames.has(outcome.agent.name)) {
        state.diagnostics.push(
            diag(
                outcome.agent.name,
                'warning',
                'duplicate_name',
                `agent '${outcome.agent.name}' already discovered (first-wins)`,
                path,
            ),
        );
        return;
    }
    if (state.agents.length >= state.maxAgents) {
        state.diagnostics.push(
            diag(outcome.agent.name, 'warning', 'limit_reached', `max agents limit (${state.maxAgents}) reached`, path),
        );
        return;
    }
    state.seenNames.add(outcome.agent.name);
    state.agents.push(outcome.agent);
}

async function tryLoadAgentFile(filePath: string, source: AgentSource, maxFileSize: number): Promise<LoadOutcome> {
    const fallback = deriveAgentName(filePath);
    if (absolutePathMatchesDenylist(filePath)) {
        return ok(diag(fallback, 'warning', 'denylisted', 'path matches the discovery denylist', filePath));
    }
    let stats: { readonly size: number; readonly isSymbolicLink: () => boolean };
    try {
        stats = await lstat(filePath);
    } catch {
        return { kind: 'drop' };
    }
    if (stats.isSymbolicLink()) {
        return ok(diag(fallback, 'warning', 'symlink_skipped', 'symbolic link entries are not loaded', filePath));
    }
    if (stats.size > maxFileSize) {
        return ok(
            diag(
                fallback,
                'warning',
                'size_exceeded',
                `file exceeds size bound (${stats.size} > ${maxFileSize} bytes)`,
                filePath,
            ),
        );
    }
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        return ok(diag(fallback, 'error', 'read_failed', `read failed: ${instanceMessage(error)}`, filePath));
    }
    try {
        return { kind: 'loaded', agent: parseAgentFile(filePath, contents, source) };
    } catch (error: unknown) {
        const msg = error instanceof AgentParseError ? error.message : `parse failed: ${instanceMessage(error)}`;
        return ok(diag(fallback, 'error', 'parse_error', msg, filePath));
    }
}

function tryLoadBundledTemplate(template: string): LoadOutcome {
    try {
        return { kind: 'loaded', agent: parseAgentFile(BUNDLED_PATH, template, 'bundled') };
    } catch (error: unknown) {
        const msg =
            error instanceof AgentParseError ? error.message : `bundled parse failed: ${instanceMessage(error)}`;
        return ok(diag(BUNDLED_PATH, 'error', 'parse_error', msg, BUNDLED_PATH));
    }
}

function resolveAgentScopes(options: DiscoverAgentsOptions, wsDenied: boolean): readonly ScopeDescriptor[] {
    const scopes: ScopeDescriptor[] = [
        { source: 'project', dir: join(options.workspaceRoot, '.mctrl', 'agents'), skipped: wsDenied },
        { source: 'user', dir: join(options.userConfigDir, 'agents'), skipped: false },
    ];
    for (const dir of options.additionalDirs ?? []) {
        scopes.push({ source: 'plugin', dir, skipped: false });
    }
    return scopes;
}

async function walkAgentFiles(scopeRoot: string): Promise<readonly string[]> {
    const results: string[] = [];
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: scopeRoot, depth: 0 }];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined || item.depth > MAX_WALK_DEPTH) continue;
        let entries: readonly Dirent[];
        try {
            entries = await readdir(item.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!denylistDirNames.has(entry.name.toLowerCase())) {
                    queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
                }
                continue;
            }
            if (entry.name.endsWith(AGENT_FILE_SUFFIX) && (entry.isFile() || entry.isSymbolicLink())) {
                results.push(join(item.dir, entry.name));
            }
        }
    }
    return results.sort();
}

function diag(
    agentName: string,
    severity: 'error' | 'warning' | 'info',
    code: string,
    message: string,
    path: string,
): AgentDiscoveryDiagnostic {
    return { agentName, severity, code, message, path };
}

function ok(diagnostic: AgentDiscoveryDiagnostic): LoadOutcome {
    return { kind: 'diagnostic', diagnostic };
}

function absolutePathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return denylistNeedles.some(
        (n) => n.length > 0 && (posix === n || posix.includes(`/${n}/`) || posix.endsWith(`/${n}`)),
    );
}

function deriveAgentName(filePath: string): string {
    const base = basename(filePath).replace(/\.md$/u, '');
    return base.length > 0 ? base : basename(filePath);
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
