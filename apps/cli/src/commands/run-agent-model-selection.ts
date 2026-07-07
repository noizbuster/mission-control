import { getRuntimeModelProviderCatalog } from '@mission-control/config';
import { type AgentModelLookup, discoverAgents, resolveUserConfigDir } from '@mission-control/core';
import type { AbgNodeModelOptions, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import type { ProviderAuthStore } from '../auth-store.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import type { ModelDiscovery } from './model-discovery.js';

export async function resolveModelProviderSelection(
    args: CliArgs,
    authStore: ProviderAuthStore,
): Promise<ModelProviderSelection | undefined> {
    if (args.modelProviderSelection !== undefined) {
        return args.modelProviderSelection;
    }
    return authStore.getDefaultSelection();
}

export async function listAuthenticatedModelChoices(
    authStore: ProviderAuthStore,
    modelDiscovery: ModelDiscovery,
): Promise<readonly ModelChoice[]> {
    const authFile = await authStore.readAuthFile();
    const providerIDs = await listAuthenticatedProviderIDs(authStore);
    const runtimeCatalog = await getRuntimeModelProviderCatalog();
    const baseChoices = createModelChoices({ catalog: runtimeCatalog, providerIDs });
    const choices: ModelChoice[] = [];

    for (const providerID of providerIDs) {
        const provider = runtimeCatalog.find((entry) => entry.id === providerID);
        const credential = authFile.credentials[providerID];
        const providerChoices = baseChoices.filter((choice) => choice.selection.providerID === providerID);
        if (provider === undefined || credential === undefined) {
            choices.push(...providerChoices);
            continue;
        }

        const discoveredModelIDs = await modelDiscovery({ provider, credential });
        if (discoveredModelIDs === undefined) {
            choices.push(...providerChoices);
            continue;
        }
        const catalogModelIDs = new Set(providerChoices.map((choice) => choice.selection.modelID));
        const extraChoices: ModelChoice[] = discoveredModelIDs
            .filter((id) => !catalogModelIDs.has(id))
            .map((id) => {
                const label = `${providerID}/${id}`;
                return {
                    id: label,
                    label,
                    selection: { providerID, modelID: id },
                    capabilityStatus: provider.capability.status,
                    availableForCoding: true,
                };
            });
        choices.push(...providerChoices, ...extraChoices);
    }

    return choices;
}

export async function buildAgentModelLookup(workspaceRoot: string): Promise<AgentModelLookup | undefined> {
    const result = await discoverAgents({
        workspaceRoot,
        userConfigDir: resolveUserConfigDir(),
    });
    const index = new Map<string, AbgNodeModelOptions>();
    for (const agent of result.agents) {
        if (agent.model === undefined || agent.disabled === true) continue;
        const resolved = typeof agent.model === 'string' ? parseAgentModelString(agent.model) : agent.model;
        if (resolved !== undefined) {
            index.set(agent.name, resolved);
        }
    }
    if (index.size === 0) return undefined;
    return (name: string) => index.get(name);
}

async function listAuthenticatedProviderIDs(authStore: ProviderAuthStore): Promise<readonly string[]> {
    const summaries = await authStore.listCredentialSummaries();
    return summaries.filter((summary) => summary.authenticated).map((summary) => summary.providerID);
}

function parseAgentModelString(value: string): AbgNodeModelOptions | undefined {
    const sep = value.indexOf('/');
    if (sep <= 0 || sep === value.length - 1) return undefined;
    return { providerID: value.slice(0, sep), modelID: value.slice(sep + 1) };
}
