/**
 * Cross-harness agent provider registry. The 9 providers below import agent
 * definitions from other coding-agent harnesses (Claude Code, Cursor, Codex,
 * Gemini, Cline, Windsurf, VS Code, GitHub Copilot, OpenCode). Each scans its
 * own directories and returns {@linkcode AgentDefinition} objects through the
 * shared {@linkcode AgentPluginProvider} interface.
 *
 * {@linkcode registerBuiltinProviders} wires all 9 into a
 * {@linkcode CapabilityRegistry}. It is called by {@linkcode discoverAgents}
 * after registering the priority-100 builtin 4-scope provider, so
 * mission-control's own agents always win name conflicts over imported ones.
 */
import type { CapabilityRegistry } from '../capability/index';
import type { AgentPluginProvider } from '../capability/types';
import { claudeCodeAgentProvider } from './claude-provider';
import { clineAgentProvider } from './cline-provider';
import { codexAgentProvider } from './codex-provider';
import { cursorAgentProvider } from './cursor-provider';
import { geminiAgentProvider } from './gemini-provider';
import { githubCopilotProvider } from './github-copilot-provider';
import { opencodeProvider } from './opencode-provider';
import { vscodeProvider } from './vscode-provider';
import { windsurfAgentProvider } from './windsurf-provider';

export const CROSS_HARNESS_PROVIDERS: readonly AgentPluginProvider[] = [
    claudeCodeAgentProvider,
    cursorAgentProvider,
    codexAgentProvider,
    geminiAgentProvider,
    clineAgentProvider,
    windsurfAgentProvider,
    vscodeProvider,
    githubCopilotProvider,
    opencodeProvider,
];

export function registerBuiltinProviders(registry: CapabilityRegistry): void {
    for (const provider of CROSS_HARNESS_PROVIDERS) {
        registry.registerProvider(provider);
    }
}
