/**
 * AI-SDK model resolver (Phase 5 keystone, D2).
 *
 * Maps a `ModelProviderSelection` (providerID + modelID) to a Vercel AI SDK `LanguageModelV3`
 * (= `LlmActorModel`). This is the `resolveSdkModel` bridge the coding-agent graph needs:
 * once it exists, the CLI can cut over from the flat loop to `AgentRuntime.runGraph` with real
 * providers (completing the Phase 3 cutover).
 *
 * Credential resolution is ASYNC (auth store), but `resolveSdkModel` is called synchronously per
 * node run — so this is an async FACTORY that resolves the credential once (for the run's
 * provider) and returns a sync resolver. The coding-agent graph uses a single model, so
 * pre-resolving its credential is correct.
 *
 * Phase 5 scope here: the anthropic / openai / openai-compatible mapping. The full migration
 * (delete each adapter's bespoke SSE parsing, route usage → policy.budget.*) is incremental;
 * `provider-events.ts` stays the canonical ABG Signal vocabulary (no dual vocabulary).
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { AbgNodeModelOptions, ProviderCredential } from '@mission-control/protocol';
import type { LlmActorModel } from '../../behavior/nodes/llm-actor/llm-actor-node.js';
import type { ProviderCredentialResolver } from '../credential-resolver.js';

export type SdkModelResolver = (options: AbgNodeModelOptions) => LlmActorModel;

export type CreateSdkModelResolverInput = {
    readonly providerID: string;
    /** Credential resolver (skipped when `apiKey` is provided). */
    readonly credentialResolver?: ProviderCredentialResolver;
    /** Override base URL (openai-compatible providers). */
    readonly baseURL?: string;
    /** Pre-resolved API key (skips the credential resolver — used in tests/smoke). */
    readonly apiKey?: string;
};

export class SdkModelResolverError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SdkModelResolverError';
    }
}

/**
 * Resolve the credential + return a sync `(AbgNodeModelOptions) => LlmActorModel`.
 * Throws `SdkModelResolverError` if the provider has no AI-SDK mapping or no credential.
 */
export async function createSdkModelResolver(input: CreateSdkModelResolverInput): Promise<SdkModelResolver> {
    const apiKey =
        input.apiKey ??
        (input.credentialResolver !== undefined
            ? await resolveApiKey(input.credentialResolver, input.providerID)
            : undefined);
    return (options) =>
        buildSdkModel({
            providerID: options.providerID ?? input.providerID,
            modelID: options.modelID,
            apiKey,
            ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
        });
}

function buildSdkModel(input: {
    readonly providerID: string;
    readonly modelID: string;
    readonly apiKey: string | undefined;
    readonly baseURL?: string;
}): LlmActorModel {
    switch (input.providerID) {
        case 'anthropic': {
            return createAnthropic(withApiKey(input.apiKey)).languageModel(input.modelID);
        }
        case 'openai':
        case 'openai-responses': {
            return createOpenAI(withApiKey(input.apiKey)).languageModel(input.modelID);
        }
        case 'openai-compatible': {
            const settings = {
                ...withApiKey(input.apiKey),
                ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
            };
            return createOpenAI(settings).languageModel(input.modelID);
        }
        default:
            throw new SdkModelResolverError(
                `provider "${input.providerID}" has no AI-SDK mapping (anthropic/openai/openai-compatible supported; local providers use a scripted SDK model directly)`,
            );
    }
}

function withApiKey(apiKey: string | undefined): { readonly apiKey?: string } {
    return apiKey !== undefined ? { apiKey } : {};
}

async function resolveApiKey(resolver: ProviderCredentialResolver, providerID: string): Promise<string | undefined> {
    const credential = await resolver.resolveProviderCredential({ providerID });
    return extractApiKey(credential);
}

function extractApiKey(credential: ProviderCredential | undefined): string | undefined {
    if (credential === undefined || typeof credential !== 'object' || !('apiKey' in credential)) {
        return undefined;
    }
    const apiKey = (credential as { apiKey?: unknown }).apiKey;
    return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
}
