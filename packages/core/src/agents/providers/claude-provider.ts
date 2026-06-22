/**
 * Claude Code agent provider. Scans `.claude/agents/*.md` at project scope
 * and `claude/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Delegates frontmatter conversion to the shared
 * {@linkcode ./_claude-compatible.js#loadClaudeCompatibleAgents} helper so
 * Cursor (todo 10) can reuse the same pipeline.
 *
 * Missing directories yield empty arrays. Broken or oversized files are
 * skipped with an `unsupported_field` or `parse_error` diagnostic surfaced
 * through `loadClaudeCompatibleAgents` (the provider interface returns only
 * agents; diagnostics are available on the helper's return value).
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { AgentPluginProvider, LoadContext } from '../capability/types.js';
import { loadClaudeCompatibleAgents } from './_claude-compatible.js';
import { join } from 'node:path';

async function loadAgents(ctx: LoadContext): Promise<readonly AgentDefinition[]> {
    const dirs = [join(ctx.workspaceRoot, '.claude', 'agents'), join(ctx.userConfigDir, 'claude', 'agents')];
    const result = await loadClaudeCompatibleAgents(ctx, dirs, 'claude-code');
    return result.agents;
}

export const claudeCodeAgentProvider: AgentPluginProvider = {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Imports agents from .claude/agents/*.md (Claude Code subagents)',
    priority: 50,
    loadAgents,
};
