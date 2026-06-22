/**
 * Gemini agent provider. Scans `.gemini/agents/*.md` at project scope and
 * `gemini/agents/*.md` at user scope for Claude-compatible markdown agent
 * definitions. Missing directories yield empty arrays; broken or oversized
 * files are skipped without halting the scan. `AGENTS.md` is never parsed as
 * an agent.
 */
import type { AgentDefinition, AgentSource } from '@mission-control/protocol';
import { parseAgentFile } from '../agent-parser.js';
import type { AgentPluginProvider, LoadContext } from '../capability/types.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const AGENT_FILE_SUFFIX = '.md';
const EXCLUDED_FILE_NAME = 'agents.md';
const MAX_FILE_BYTES = 64 * 1024;

async function loadAgents(ctx: LoadContext): Promise<readonly AgentDefinition[]> {
    const scopes: ReadonlyArray<{ readonly dir: string; readonly source: AgentSource }> = [
        { dir: join(ctx.workspaceRoot, '.gemini', 'agents'), source: 'project' },
        { dir: join(ctx.userConfigDir, 'gemini', 'agents'), source: 'user' },
    ];
    const agents: AgentDefinition[] = [];
    for (const scope of scopes) {
        agents.push(...(await scanAgentDir(scope.dir, scope.source)));
    }
    return agents;
}

async function scanAgentDir(dir: string, source: AgentSource): Promise<readonly AgentDefinition[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const agents: AgentDefinition[] = [];
    for (const entry of sorted) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(AGENT_FILE_SUFFIX)) continue;
        if (entry.name.toLowerCase() === EXCLUDED_FILE_NAME) continue;

        const agent = await tryLoadAgent(join(dir, entry.name), source);
        if (agent !== undefined) agents.push(agent);
    }
    return agents;
}

async function tryLoadAgent(filePath: string, source: AgentSource): Promise<AgentDefinition | undefined> {
    try {
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_BYTES) return undefined;
        const contents = await readFile(filePath, 'utf8');
        return parseAgentFile(filePath, contents, source);
    } catch {
        return undefined;
    }
}

export const geminiAgentProvider: AgentPluginProvider = {
    id: 'gemini',
    displayName: 'Gemini',
    description: 'Imports agents from .gemini/agents/*.md (Gemini custom agents)',
    priority: 50,
    loadAgents,
};
