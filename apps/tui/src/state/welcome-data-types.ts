/**
 * Welcome-screen data shapes (pure types only).
 *
 * The factory that builds a {@link WelcomeData} payload stays in the CLI
 * (the CLI package) because it reads the session
 * catalog and CLI version. Components consume only these portable types.
 */

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
