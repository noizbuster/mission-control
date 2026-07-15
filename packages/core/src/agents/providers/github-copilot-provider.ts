/**
 * GitHub Copilot agent provider. Scans `<workspace>/.github/copilot/agents/*.md`
 * for agent definition files in the standard markdown + YAML frontmatter
 * shape. Project-only; Copilot has no user-level agent config directory.
 */
import type { AgentPluginProvider } from '../capability/types';
import { scanAgentMarkdownDir } from './scan-agent-dir';
import { join } from 'node:path';

export const githubCopilotProvider: AgentPluginProvider = {
    id: 'github-copilot',
    displayName: 'GitHub Copilot',
    description: 'Import agents from .github/copilot/agents/*.md',
    priority: 50,
    async loadAgents(ctx) {
        return scanAgentMarkdownDir(join(ctx.workspaceRoot, '.github', 'copilot', 'agents'), 'project');
    },
};
