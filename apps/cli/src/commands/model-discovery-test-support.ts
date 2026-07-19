import { modelProviderCatalog } from '@mission-control/config';
import type { ModelDiscoveryFetch } from './model-discovery';

export type RecordedModelDiscoveryRequest = {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
};

export function createDataModelResponse(modelIDs: readonly string[]): unknown {
    return {
        data: modelIDs.map((id) => ({ id })),
    };
}

export function createFetch(requests: RecordedModelDiscoveryRequest[], responseBody: unknown): ModelDiscoveryFetch {
    return createFetchWithStatus(requests, true, responseBody);
}

export function createFetchWithStatus(
    requests: RecordedModelDiscoveryRequest[],
    ok: boolean,
    responseBody: unknown,
): ModelDiscoveryFetch {
    return async (url, init) => {
        requests.push({ url, headers: init.headers });
        return {
            ok,
            json: async () => responseBody,
        };
    };
}

export function createFieldsCredential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'fields' as const,
        fields: {
            apiKey: {
                value: apiKey,
                secret: true,
            },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

export function findProvider(providerID: string) {
    const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
    if (provider === undefined) {
        throw new Error(`missing provider fixture: ${providerID}`);
    }
    return provider;
}
