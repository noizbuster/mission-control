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
 * Phase 5 scope here: the anthropic / openai / openai-compatible / google-gemini mapping. The full
 * migration (delete each adapter's bespoke SSE parsing, route usage → policy.budget.*) is
 * incremental; `provider-events.ts` stays the canonical ABG Signal vocabulary (no dual vocabulary).
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { AbgNodeModelOptions, ProviderCredential } from '@mission-control/protocol';
import type { LlmActorModel } from '../../behavior/nodes/llm-actor/llm-actor-node.js';
import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { openAICompatibleProviderSpec } from '../openai-compatible/openai-compatible-specs.js';

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
    // Real OpenAI-compatible providers (zai-coding-plan, openrouter, groq, deepseek, mistral) are
    // identified by their spec entry, which carries the full chat-completions endpoint. @ai-sdk/openai
    // appends '/chat/completions' to its base, so derive the base by stripping that suffix. An
    // explicit `baseURL` override (escape hatch) wins over the spec endpoint.
    const compatibleSpec = openAICompatibleProviderSpec(input.providerID);
    if (compatibleSpec !== undefined) {
        return createOpenAI({
            ...withApiKey(input.apiKey),
            baseURL: input.baseURL ?? openAICompatibleBaseURL(compatibleSpec.endpoint),
        }).chat(input.modelID);
    }
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
        case 'google':
        case 'google-gemini': {
            return createGoogleGenerativeAI(withApiKey(input.apiKey)).languageModel(input.modelID);
        }
        default:
            throw new SdkModelResolverError(
                `provider "${input.providerID}" has no AI-SDK mapping (anthropic/openai/openai-compatible/google-gemini supported; local providers use a scripted SDK model directly)`,
            );
    }
}

function withApiKey(apiKey: string | undefined): { readonly apiKey?: string } {
    return apiKey !== undefined ? { apiKey } : {};
}

/**
 * Derive the @ai-sdk/openai base URL from a full chat-completions endpoint. The OpenAI-compatible
 * provider specs store the FULL endpoint (the flat-path transport POSTs to it directly); the AI-SDK
 * `createOpenAI` appends '/chat/completions' to its base, so strip the suffix when present. Specs
 * are consistently shaped (`…/chat/completions`), so a non-matching endpoint is returned unchanged.
 */
function openAICompatibleBaseURL(endpoint: string): string {
    const suffix = '/chat/completions';
    return endpoint.endsWith(suffix) ? endpoint.slice(0, -suffix.length) : endpoint;
}

async function resolveApiKey(resolver: ProviderCredentialResolver, providerID: string): Promise<string | undefined> {
    const credential = await resolver.resolveProviderCredential({ providerID });
    return extractApiKey(credential);
}

function extractApiKey(credential: ProviderCredential | undefined): string | undefined {
    if (credential === undefined || typeof credential !== 'object') {
        return undefined;
    }
    // The auth store persists an `apiKey`-type credential OR a `fields`-type credential (e.g.
    // zai-coding-plan stores `ZHIPU_API_KEY` as a named field). Both carry the bearer secret; pull
    // it from whichever shape is present. OAuth credentials are not bearer API keys → undefined.
    if (credential.type === 'apiKey') {
        return credential.apiKey.length > 0 ? credential.apiKey : undefined;
    }
    if (credential.type === 'fields') {
        const secret = Object.values(credential.fields).find((field) => field.secret)?.value;
        return typeof secret === 'string' && secret.length > 0 ? secret : undefined;
    }
    return undefined;
}
