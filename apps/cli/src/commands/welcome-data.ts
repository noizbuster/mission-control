import { defaultModelProviderSelection } from '@mission-control/config';
import {
    DEFAULT_LSP_SERVERS,
    discoverSkills,
    type LspServerConfig,
    type LspServerManager,
    loadResolvedMcpConfig,
    type ResolvedMcpServer,
    type Skill,
} from '@mission-control/core';
import { getVersion } from '../index.js';
import type { CliSessionCatalogEntry } from './session-catalog.js';
import { listSessionCatalogEntriesForWorkspace } from './session-catalog.js';

/**
 * A configured MCP server surfaced on the welcome screen. We collapse the
 * local/remote discriminant into a single `type` label and keep the scope so
 * the user can see whether a server came from `.mcp.json` (project) or the
 * user `config.json`.
 */
export type WelcomeMcpServer = {
    readonly name: string;
    readonly type: 'stdio' | 'remote';
    readonly scope: 'user' | 'project';
};

/** A project-scoped skill (loaded from `.mctrl/skills` or `.agents/skills`). */
export type WelcomeSkill = {
    readonly name: string;
    readonly description?: string;
    readonly scopeId: 'project-mctrl' | 'project-agents' | 'project-plugin';
};

/** An LSP server from the built-in catalog, marked with PATH availability. */
export type WelcomeLspServer = {
    readonly languageId: string;
    readonly command: string;
    readonly available: boolean;
};

/** A recent session row, trimmed to the fields the welcome screen renders. */
export type WelcomeSession = {
    readonly sessionId: string;
    readonly updatedAt?: string;
    readonly messageCount: number;
};

/**
 * The full welcome-screen payload. Every section is independently gathered so
 * a failure in one (e.g. MCP config parse error) does not suppress the others.
 */
export type WelcomeData = {
    readonly version: string;
    readonly defaultModel: { readonly providerID: string; readonly modelID: string };
    readonly mcpServers: readonly WelcomeMcpServer[];
    readonly projectSkills: readonly WelcomeSkill[];
    readonly lspServers: readonly WelcomeLspServer[];
    readonly recentSessions: readonly WelcomeSession[];
};

/** Maximum number of recent sessions to show on the welcome screen. */
export const WELCOME_SESSION_LIMIT = 3;

/** Hard upper bound for the LSP PATH probe so startup cannot hang on a stuck `which`. */
const LSP_PROBE_TIMEOUT_MS = 1500;

export type GatherWelcomeDataDeps = {
    /**
     * Override the LSP probe. Tests inject a deterministic available list;
     * production wires {@link LspServerManager.detectAvailableServers}.
     */
    readonly detectLspServers?: () => Promise<readonly LspServerConfig[]>;
};

export type GatherWelcomeDataOptions = {
    readonly workspaceRoot?: string;
    readonly profileName?: string;
    readonly deps?: GatherWelcomeDataDeps;
};

/** Convert a {@link ResolvedMcpServer} union into the collapsed welcome view. */
export function toWelcomeMcpServer(server: ResolvedMcpServer): WelcomeMcpServer {
    return {
        name: server.name,
        type: server.type === 'remote' ? 'remote' : 'stdio',
        scope: server.scope,
    };
}

export type ProjectSkillScopeId = 'project-mctrl' | 'project-agents' | 'project-plugin';

function isProjectScopeId(scopeId: string): scopeId is ProjectSkillScopeId {
    return scopeId === 'project-mctrl' || scopeId === 'project-agents' || scopeId === 'project-plugin';
}

/** Filter skills down to project-scoped, sorted by name for stable display. */
export function selectProjectSkills(skills: readonly Skill[]): readonly WelcomeSkill[] {
    const project = skills.filter(
        (skill): skill is Skill & { readonly sourceInfo: { readonly scopeId: ProjectSkillScopeId } } =>
            skill.sourceInfo.scope === 'project' && isProjectScopeId(skill.sourceInfo.scopeId),
    );
    return project
        .map((skill): WelcomeSkill => {
            const base: WelcomeSkill = {
                name: skill.name,
                scopeId: skill.sourceInfo.scopeId,
            };
            return skill.description.length > 0 ? { ...base, description: skill.description } : base;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the welcome LSP view by diffing the static catalog against the probed
 * availability list. Languages with `available=true` shipped a binary on PATH.
 */
export function buildWelcomeLspServers(
    catalog: readonly LspServerConfig[],
    available: readonly LspServerConfig[],
): readonly WelcomeLspServer[] {
    const availableLangs = new Set(available.map((server) => server.languageId));
    return catalog.map((server) => ({
        languageId: server.languageId,
        command: server.command,
        available: availableLangs.has(server.languageId),
    }));
}

/** Trim a catalog entry to the fields the welcome screen renders. */
export function toWelcomeSession(entry: CliSessionCatalogEntry): WelcomeSession {
    const base: WelcomeSession = {
        sessionId: entry.sessionId,
        messageCount: entry.messageCount,
    };
    return entry.updatedAt !== undefined ? { ...base, updatedAt: entry.updatedAt } : base;
}

async function gatherMcpServers(
    workspaceRoot: string | undefined,
    profileName: string | undefined,
): Promise<readonly WelcomeMcpServer[]> {
    try {
        const config = await loadResolvedMcpConfig({
            ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
            ...(profileName !== undefined ? { profileName } : {}),
        });
        return config.servers.filter((server) => server.enabled).map(toWelcomeMcpServer);
    } catch {
        return [];
    }
}

async function gatherProjectSkills(workspaceRoot: string | undefined): Promise<readonly WelcomeSkill[]> {
    if (workspaceRoot === undefined) return [];
    try {
        const result = await discoverSkills({ workspaceRoot });
        return selectProjectSkills(result.skills);
    } catch {
        return [];
    }
}

async function gatherRecentSessions(workspaceRoot: string | undefined): Promise<readonly WelcomeSession[]> {
    if (workspaceRoot === undefined) return [];
    try {
        const entries = await listSessionCatalogEntriesForWorkspace(workspaceRoot);
        return entries.slice(0, WELCOME_SESSION_LIMIT).map(toWelcomeSession);
    } catch {
        return [];
    }
}

async function gatherLspServers(deps: GatherWelcomeDataDeps | undefined): Promise<readonly WelcomeLspServer[]> {
    const probe = deps?.detectLspServers;
    if (probe !== undefined) {
        try {
            const available = await raceWithTimeout(probe(), LSP_PROBE_TIMEOUT_MS, []);
            return buildWelcomeLspServers(DEFAULT_LSP_SERVERS, available);
        } catch {
            return buildWelcomeLspServers(DEFAULT_LSP_SERVERS, []);
        }
    }
    // Lazy-import the manager so non-TUI runs never spawn `which`.
    try {
        const { LspServerManager } = await import('@mission-control/core');
        const manager = new LspServerManager({ workspaceRoot: process.cwd() });
        const available = await raceWithTimeout(manager.detectAvailableServers(), LSP_PROBE_TIMEOUT_MS, []);
        return buildWelcomeLspServers(DEFAULT_LSP_SERVERS, available);
    } catch {
        return buildWelcomeLspServers(DEFAULT_LSP_SERVERS, []);
    }
}

/**
 * Race a promise against a timeout. On timeout or rejection, resolve to
 * `fallback` so the caller never has to handle a rejection. Used only for the
 * LSP PATH probe, which can hang on systems with a misbehaving `which`.
 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            }),
        ]);
    } catch {
        return fallback;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Gather every welcome-screen section in parallel. Each section is wrapped so
 * one section's failure never breaks the others; the user always sees the
 * screen even if (for example) MCP config parsing throws.
 */
export async function gatherWelcomeData(options: GatherWelcomeDataOptions = {}): Promise<WelcomeData> {
    const workspaceRoot = options.workspaceRoot;
    const [mcpServers, projectSkills, recentSessions, lspServers] = await Promise.all([
        gatherMcpServers(workspaceRoot, options.profileName),
        gatherProjectSkills(workspaceRoot),
        gatherRecentSessions(workspaceRoot),
        gatherLspServers(options.deps),
    ]);
    return {
        version: getVersion(),
        defaultModel: {
            providerID: defaultModelProviderSelection.providerID,
            modelID: defaultModelProviderSelection.modelID,
        },
        mcpServers,
        projectSkills,
        recentSessions,
        lspServers,
    };
}
