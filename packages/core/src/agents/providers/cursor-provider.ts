/**
 * Cursor agent provider. Scans `.cursor/agents/*.md` at project scope and
 * `cursor/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions (Cursor reuses the Claude agent frontmatter format). Delegates
 * frontmatter conversion to the shared
 * {@linkcode ./_claude-compatible.js#loadClaudeCompatibleAgents} helper so the
 * same conversion pipeline serves both harnesses.
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
    const dirs = [join(ctx.workspaceRoot, '.cursor', 'agents'), join(ctx.userConfigDir, 'cursor', 'agents')];
    const result = await loadClaudeCompatibleAgents(ctx, dirs, 'cursor');
    return result.agents;
}

export const cursorAgentProvider: AgentPluginProvider = {
    id: 'cursor',
    displayName: 'Cursor',
    description: 'Import agents from .cursor/agents/*.md (Cursor uses Claude-compatible format)',
    priority: 50,
    loadAgents,
};
