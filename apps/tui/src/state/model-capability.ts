import type { ModelProviderCatalogEntry } from '@mission-control/config';

export function formatProviderCapabilityStatus(provider: ModelProviderCatalogEntry): string {
    const status = provider.capability.status;
    if (status === 'executable') {
        return status;
    }
    return `${status} (cannot run coding agent prompts)`;
}

export function formatProviderCapabilityBadge(provider: ModelProviderCatalogEntry): string {
    const status = provider.capability.status;
    if (status === 'executable') {
        return '[executable]';
    }
    return `[${status}: cannot run coding agent prompts]`;
}

export function getProviderCodingUnavailableReason(provider: ModelProviderCatalogEntry): string | undefined {
    const status = provider.capability.status;
    if (status === 'executable') {
        return undefined;
    }
    return `Provider ${provider.id} is ${status} and cannot run coding agent prompts`;
}
