/**
 * Codex agent provider. Scans `.codex/agents/*.md` at project scope and
 * `codex/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Missing directories yield empty arrays; broken or oversized
 * files are skipped without halting the scan. `AGENTS.md` is never parsed as
 * an agent. Directory scanning is delegated to the shared
 * {@linkcode scanAgentMarkdownDir} helper with deterministic sort and a 64 KiB
 * per-file size guard.
 */
import type { AgentDefinition, AgentSource } from '@mission-control/protocol';
import type { AgentPluginProvider, LoadContext } from '../capability/types';
import { scanAgentMarkdownDir } from './scan-agent-dir';
import { join } from 'node:path';

const MAX_FILE_BYTES = 64 * 1024;

async function loadAgents(ctx: LoadContext): Promise<readonly AgentDefinition[]> {
    const scopes: ReadonlyArray<{ readonly dir: string; readonly source: AgentSource }> = [
        { dir: join(ctx.workspaceRoot, '.codex', 'agents'), source: 'project' },
        { dir: join(ctx.userConfigDir, 'codex', 'agents'), source: 'user' },
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
    return agents;
}

export const codexAgentProvider: AgentPluginProvider = {
    id: 'codex',
    displayName: 'Codex',
    description: 'Imports agents from .codex/agents/*.md (Codex custom agents)',
    priority: 50,
    loadAgents,
};
