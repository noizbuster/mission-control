import type { AgentDefinition } from '@mission-control/protocol';
import { errorToString } from '../../util/error-to-string';
import type { AgentDiscoveryDiagnostic, DiscoverAgentsResult } from '../agent-loader';
import type { AgentPluginProvider, LoadContext } from './types';

/**
 * Priority-based registry of cross-harness agent providers. Providers register with a
 * numeric priority; {@linkcode loadAll} sorts them descending, invokes each provider's
 * `loadAgents`, and deduplicates by agent name — highest priority wins. A rejecting
 * provider produces a `provider_error` diagnostic and does not halt the load. The
 * registry performs no file I/O; all scanning happens inside each provider's
 * `loadAgents(ctx)` call.
 */
export class CapabilityRegistry {
    private readonly providers = new Map<string, AgentPluginProvider>();
    private readonly disabledProviderIds = new Set<string>();

    registerProvider(provider: AgentPluginProvider): void {
        this.providers.set(provider.id, provider);
    }

    disableProvider(id: string): void {
        this.disabledProviderIds.add(id);
    }

    enableProvider(id: string): void {
        this.disabledProviderIds.delete(id);
    }

    list(): readonly AgentPluginProvider[] {
        return [...this.providers.values()];
    }

    async loadAll(ctx: LoadContext): Promise<DiscoverAgentsResult> {
        const ordered = [...this.providers.values()].sort((a, b) => b.priority - a.priority);

        const agents: AgentDefinition[] = [];
        const diagnostics: AgentDiscoveryDiagnostic[] = [];
        const seenNames = new Set<string>();

        for (const provider of ordered) {
            if (this.disabledProviderIds.has(provider.id)) continue;

            let loaded: readonly AgentDefinition[];
            let providerDiagnostics: readonly AgentDiscoveryDiagnostic[];
            try {
                const result = await provider.loadAgents(ctx);
                loaded = result.agents;
                providerDiagnostics = result.diagnostics;
            } catch (error: unknown) {
                const detail = errorToString(error);
                diagnostics.push({
                    agentName: `<provider:${provider.id}>`,
                    severity: 'error',
                    code: 'provider_error',
                    message: `[${provider.displayName}] ${detail}`,
                });
                continue;
            }

            diagnostics.push(...providerDiagnostics);
            for (const agent of loaded) {
                if (seenNames.has(agent.name)) {
                    diagnostics.push({
                        agentName: agent.name,
                        severity: 'warning',
                        code: 'duplicate_name',
                        message: `agent '${agent.name}' already loaded by a higher-priority provider; shadowing provider '${provider.id}'`,
                    });
                    continue;
                }
                seenNames.add(agent.name);
                agents.push(agent);
            }
        }
        return { agents, diagnostics };
    }
}

export type { AgentPluginProvider, AgentPluginProviderLoadResult, LoadContext } from './types';
