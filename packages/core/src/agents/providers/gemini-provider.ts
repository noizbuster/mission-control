/**
 * Gemini agent provider. Scans `.gemini/agents/*.md` at project scope and
 * `gemini/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Missing directories yield empty arrays; broken or oversized
 * files are skipped without halting the scan. `AGENTS.md` is never parsed as
 * an agent. Directory scanning is delegated to the shared
 * {@linkcode scanAgentMarkdownDir} helper with deterministic sort and a 64 KiB
 * per-file size guard.
 */
import type { AgentDefinition, AgentSource } from '@mission-control/protocol';
import type { AgentPluginProvider, AgentPluginProviderLoadResult, LoadContext } from '../capability/types';
import { scanAgentMarkdownDir } from './scan-agent-dir';
import { join } from 'node:path';

const MAX_FILE_BYTES = 64 * 1024;

async function loadAgents(ctx: LoadContext): Promise<AgentPluginProviderLoadResult> {
    const scopes: ReadonlyArray<{ readonly dir: string; readonly source: AgentSource }> = [
        { dir: join(ctx.workspaceRoot, '.gemini', 'agents'), source: 'project' },
        { dir: join(ctx.userConfigDir, 'gemini', 'agents'), source: 'user' },
    ];
    const agents: AgentDefinition[] = [];
    for (const scope of scopes) {
        agents.push(
            ...(await scanAgentMarkdownDir(scope.dir, scope.source, {
                sort: true,
                maxBytes: MAX_FILE_BYTES,
            })),
        );
    }
    return { agents, diagnostics: [] };
}

export const geminiAgentProvider: AgentPluginProvider = {
    id: 'gemini',
    displayName: 'Gemini',
    description: 'Imports agents from .gemini/agents/*.md (Gemini custom agents)',
    priority: 50,
    loadAgents,
};
