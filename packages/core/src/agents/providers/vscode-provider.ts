/**
 * VS Code agent provider. Scans `<workspace>/.vscode/agents/*.md` for
 * agent definition files in the standard markdown + YAML frontmatter
 * shape. Project-only; VS Code has no user-level agent config.
 */
import type { AgentPluginProvider } from '../capability/types.js';
import { scanAgentMarkdownDir } from './scan-agent-dir.js';
import { join } from 'node:path';

export const vscodeProvider: AgentPluginProvider = {
    id: 'vscode',
    displayName: 'VS Code',
    description: 'Import agents from .vscode/agents/*.md',
    priority: 50,
    async loadAgents(ctx) {
        return scanAgentMarkdownDir(join(ctx.workspaceRoot, '.vscode', 'agents'), 'project');
    },
};
