/**
 * Windsurf agent provider. Scans `.windsurf/agents/*.md` at project scope and
 * `codeium/windsurf/agents/*.md` at user scope for Claude-compatible markdown
 * agent definitions. Delegates directory scanning to the shared
 * {@linkcode scanAgentMarkdownDir} helper.
 */
import type { AgentDefinition } from '@mission-control/protocol';
import type { AgentPluginProvider, AgentPluginProviderLoadResult, LoadContext } from '../capability/types';
import { scanAgentMarkdownDir } from './scan-agent-dir';
import { join } from 'node:path';

async function loadAgents(ctx: LoadContext): Promise<AgentPluginProviderLoadResult> {
    const projectAgents = await scanAgentMarkdownDir(join(ctx.workspaceRoot, '.windsurf', 'agents'), 'project');
    const userAgents = await scanAgentMarkdownDir(join(ctx.userConfigDir, 'codeium', 'windsurf', 'agents'), 'user');
    return { agents: [...projectAgents, ...userAgents], diagnostics: [] };
}

export const windsurfAgentProvider: AgentPluginProvider = {
    id: 'windsurf',
    displayName: 'Windsurf',
    description: 'Imports agents from .windsurf/agents/*.md (Windsurf custom agents)',
    priority: 50,
    loadAgents,
};
