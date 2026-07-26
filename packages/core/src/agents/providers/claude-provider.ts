/**
 * Claude Code agent provider. Scans `.claude/agents/*.md` at project scope
 * and `claude/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Delegates frontmatter conversion to the shared
 * {@linkcode ./_claude-compatible.js#loadClaudeCompatibleAgents} helper so
 * Cursor (todo 10) can reuse the same pipeline.
 *
 * Missing directories yield empty arrays. Broken or oversized files are
 * skipped with an `unsupported_field` or `parse_error` diagnostic surfaced
 * through `loadClaudeCompatibleAgents` and propagated via the provider result.
 */
import type { AgentPluginProvider, AgentPluginProviderLoadResult, LoadContext } from '../capability/types';
import { loadClaudeCompatibleAgents } from './_claude-compatible';
import { join } from 'node:path';

async function loadAgents(ctx: LoadContext): Promise<AgentPluginProviderLoadResult> {
    const dirs = [join(ctx.workspaceRoot, '.claude', 'agents'), join(ctx.userConfigDir, 'claude', 'agents')];
    return loadClaudeCompatibleAgents(ctx, dirs, 'claude-code');
}

export const claudeCodeAgentProvider: AgentPluginProvider = {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Imports agents from .claude/agents/*.md (Claude Code subagents)',
    priority: 50,
    loadAgents,
};
