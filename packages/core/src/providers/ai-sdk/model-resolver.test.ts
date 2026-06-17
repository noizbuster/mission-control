import type { LanguageModelV3, LanguageModelV3Message, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createSdkModelResolver, SdkModelResolverError } from './model-resolver.js';

type ResolvedModel = { readonly provider: string; readonly modelId: string };

describe('createSdkModelResolver', () => {
    it('resolves an anthropic selection to an AI-SDK model', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'anthropic', apiKey: 'test-key' });
        const model = resolve({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }) as ResolvedModel;
        expect(model.provider.startsWith('anthropic')).toBe(true);
        expect(model.modelId).toBe('claude-sonnet-4-6');
    });

    it('resolves an openai selection to an AI-SDK model', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'openai', apiKey: 'test-key' });
        const model = resolve({ providerID: 'openai', modelID: 'gpt-4o' }) as ResolvedModel;
        expect(model.provider.startsWith('openai')).toBe(true);
        expect(model.modelId).toBe('gpt-4o');
    });

    it('resolves an openai-compatible selection with a baseURL override', async () => {
        const resolve = await createSdkModelResolver({
            providerID: 'openai-compatible',
            apiKey: 'test-key',
            baseURL: 'https://example.test/v1',
        });
        const model = resolve({ providerID: 'openai-compatible', modelID: 'local-model' }) as ResolvedModel;
        expect(model.provider.startsWith('openai')).toBe(true);
        expect(model.modelId).toBe('local-model');
    });

    it('resolves a real openai-compatible providerID (zai-coding-plan) to a chat-completions OpenAI model from its spec endpoint', async () => {
        // The actual providerID is the concrete spec entry ('zai-coding-plan'), NOT the generic
        // 'openai-compatible' alias — so the resolver must look it up in the spec table and derive
        // the base URL (strip '/chat/completions'). It must use the CHAT API (`.chat`), not the
        // Responses API — zai's endpoint is chat completions, and `.languageModel` defaults to
        // responses in @ai-sdk/openai v3. Without this, the graph path rejected zai-coding-plan
        // with "no AI-SDK mapping", then hit the responses endpoint /chat/completions-mismatch.
        const resolve = await createSdkModelResolver({ providerID: 'zai-coding-plan', apiKey: 'test-key' });
        const model = resolve({ providerID: 'zai-coding-plan', modelID: 'glm-5.2' }) as ResolvedModel;
        expect(model.provider).toBe('openai.chat');
        expect(model.modelId).toBe('glm-5.2');
    });

    it('extracts the API key from a fields-type credential (zai stores ZHIPU_API_KEY as a field)', async () => {
        // The auth store persists zai-coding-plan as a `fields` credential (authLabel ZHIPU_API_KEY),
        // not an `apiKey`-type. The resolver must extract the secret field value as the bearer key.
        const credentialResolver = {
            resolveProviderCredential: async () => ({
                providerID: 'zai-coding-plan',
                type: 'fields' as const,
                fields: { ZHIPU_API_KEY: { value: 'field-secret-key', secret: true } },
                createdAt: '2026-06-16T00:00:00.000Z',
                updatedAt: '2026-06-16T00:00:00.000Z',
            }),
            resolveRequiredProviderCredential: async () => ({
                providerID: 'zai-coding-plan',
                type: 'fields' as const,
                fields: { ZHIPU_API_KEY: { value: 'field-secret-key', secret: true } },
                createdAt: '2026-06-16T00:00:00.000Z',
                updatedAt: '2026-06-16T00:00:00.000Z',
            }),
            summarizeProviderCredential: async () => undefined,
            redactForOutput: (text: string) => text,
        };
        const resolve = await createSdkModelResolver({ providerID: 'zai-coding-plan', credentialResolver });
        const model = resolve({ providerID: 'zai-coding-plan', modelID: 'glm-5.2' }) as ResolvedModel;
        // Resolves without throwing AI_LoadAPIKeyError — the field secret was threaded as the key.
        expect(model.provider).toBe('openai.chat');
        expect(model.modelId).toBe('glm-5.2');
    });

    it('resolves a google-gemini selection to an AI-SDK model', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'google-gemini', apiKey: 'test-key' });
        const model = resolve({ providerID: 'google-gemini', modelID: 'gemini-2.0-flash' }) as ResolvedModel;
        expect(model.provider.startsWith('google')).toBe(true);
        expect(model.modelId).toBe('gemini-2.0-flash');
    });

    it('resolves the bare "google" providerID alias to a Google model', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'google', apiKey: 'test-key' });
        const model = resolve({ providerID: 'google', modelID: 'gemini-2.5-pro' }) as ResolvedModel;
        expect(model.provider.startsWith('google')).toBe(true);
    });

    it('throws SdkModelResolverError for an unsupported provider', async () => {
        const resolve = await createSdkModelResolver({ providerID: 'openai', apiKey: 'test-key' });
        expect(() => resolve({ providerID: 'some-unknown-provider', modelID: 'x' })).toThrow(SdkModelResolverError);
    });

    it('resolves the local/local-echo sandbox provider to the scripted AI-SDK model (flip-default enabler)', async () => {
        // local/local-echo has no network/key; the graph engine drives it via the scripted model so
        // credential-free graph runs work (unblocks the blanket flip). Verifies the resolver no
        // longer rejects 'local', and the model reproduces local-echo's deterministic branching:
        // plain prompt → "received prompt: …"; "deterministic patch" → a file.patch tool call.
        const resolve = await createSdkModelResolver({ providerID: 'local' });
        const model = resolve({ providerID: 'local', modelID: 'local-echo' }) as LanguageModelV3;
        expect(model.provider).toBe('local');
        expect(model.modelId).toBe('local-echo');

        const echoed = await collectStreamParts(model, [
            { role: 'user', content: [{ type: 'text', text: 'hello sandbox' }] },
        ]);
        expect(
            echoed.some((part) => part.type === 'text-delta' && part.delta === 'received prompt: hello sandbox'),
        ).toBe(true);
        expect(echoed.some((part) => part.type === 'finish')).toBe(true);

        const patched = await collectStreamParts(model, [
            { role: 'user', content: [{ type: 'text', text: 'apply a deterministic patch' }] },
        ]);
        expect(patched.some((part) => part.type === 'tool-call' && part.toolName === 'file.patch')).toBe(true);
    });

    it('resolves via the credential resolver when no explicit apiKey is given', async () => {
        const credentialResolver = {
            resolveProviderCredential: async () => ({
                providerID: 'anthropic',
                type: 'apiKey' as const,
                apiKey: 'resolved-key',
                createdAt: '2026-06-16T00:00:00.000Z',
                updatedAt: '2026-06-16T00:00:00.000Z',
            }),
            resolveRequiredProviderCredential: async () => ({
                providerID: 'anthropic',
                type: 'apiKey' as const,
                apiKey: 'resolved-key',
                createdAt: '2026-06-16T00:00:00.000Z',
                updatedAt: '2026-06-16T00:00:00.000Z',
            }),
            summarizeProviderCredential: async () => undefined,
            redactForOutput: (text: string) => text,
        };
        const resolve = await createSdkModelResolver({ providerID: 'anthropic', credentialResolver });
        const model = resolve({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' }) as ResolvedModel;
        expect(model.provider.startsWith('anthropic')).toBe(true);
    });
});

/** Drive the local-echo model's doStream for a prompt and collect the emitted stream parts. */
async function collectStreamParts(
    model: LanguageModelV3,
    prompt: LanguageModelV3Message[],
): Promise<readonly LanguageModelV3StreamPart[]> {
    const result = await model.doStream({ prompt });
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = result.stream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value !== undefined) {
            parts.push(value);
        }
    }
    return parts;
}
