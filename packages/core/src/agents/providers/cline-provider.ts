/**
 * Cline agent provider. Scans `.cline/agents/*.md` at project scope and
 * `cline/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Delegates directory scanning to the shared
 * {@linkcode scanAgentMarkdownDir} helper.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { AgentPluginProvider, LoadContext } from '../capability/types.js';
import { scanAgentMarkdownDir } from './scan-agent-dir.js';
import { join } from 'node:path';

async function loadAgents(ctx: LoadContext): Promise<readonly AgentDefinition[]> {
    const projectAgents = await scanAgentMarkdownDir(join(ctx.workspaceRoot, '.cline', 'agents'), 'project');
    const userAgents = await scanAgentMarkdownDir(join(ctx.userConfigDir, 'cline', 'agents'), 'user');
    return [...projectAgents, ...userAgents];
}

export const clineAgentProvider: AgentPluginProvider = {
    id: 'cline',
    displayName: 'Cline',
    description: 'Imports agents from .cline/agents/*.md (Cline custom agents)',
    priority: 50,
    loadAgents,
};
