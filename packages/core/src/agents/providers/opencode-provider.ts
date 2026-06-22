/**
 * OpenCode agent provider. Scans `<workspace>/.opencode/agent/*.md` (note:
 * singular `agent`, not `agents`) and `<userConfigDir>/opencode/agent/*.md`
 * for agent definition files in the standard markdown + YAML frontmatter
 * shape. OpenCode agents use an object-map `tools` dialect
 * (`{ "*": false, "github-triage": true }`) which {@linkcode parseAgentFile}
 * normalises to the enabled-only string array.
 */
import type { AgentPluginProvider } from '../capability/types.js';
import { scanAgentMarkdownDir } from './scan-agent-dir.js';
import { join } from 'node:path';

export const opencodeProvider: AgentPluginProvider = {
    id: 'opencode',
    displayName: 'OpenCode',
    description: 'Import agents from .opencode/agent/*.md and <config>/opencode/agent/*.md',
    priority: 50,
    async loadAgents(ctx) {
        const [project, user] = await Promise.all([
            scanAgentMarkdownDir(join(ctx.workspaceRoot, '.opencode', 'agent'), 'project'),
            scanAgentMarkdownDir(join(ctx.userConfigDir, 'opencode', 'agent'), 'user'),
        ]);
        return [...project, ...user];
    },
};
