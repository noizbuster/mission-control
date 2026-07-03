/**
 * Vision provider chain (Task 32, port-ref-tools checkbox #32).
 *
 * Each provider declares its credential gate (env-based, matching the
 * web-search-providers auth pattern) and a pure `buildRequest` /
 * `parseResponse` pair. The tool layer walks the chain in
 * {@link VISION_PROVIDER_IDS} order, skipping providers whose credentials
 * are absent, and dispatches the first available candidate's request
 * through `fetch`.
 *
 * Providers are pure data + functions: no module-level mutable state, no
 * network calls here. Image content is passed as normalized
 * {@link VisionImage} entries (mime + base64 data), so this module stays
 * trivially unit-testable via mocked `fetch`.
 *
 * Supported providers (vision-capable defaults):
 * - openai: gpt-4o-mini (image_url + file content parts)
 * - anthropic: claude-sonnet (image + document content blocks)
 * - google: gemini (inlineData parts)
 * - openrouter: OpenAI-compatible chat completions (configurable model)
 * - zai: glm-4v vision (OpenAI-compatible)
 */
import type { VisionProviderId } from './vision-schemas.js';

/** Resolved image/document content sent to a vision model. */
export type VisionImage = {
    readonly mimeType: string;
    readonly base64Data: string;
    readonly filename?: string;
};

/** Resolved vision request: the user goal plus the prepared content parts. */
export type VisionRequestInput = {
    readonly goal: string;
    readonly images: readonly VisionImage[];
};

export type VisionHttpRequest = {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
};

export interface VisionProvider {
    readonly id: VisionProviderId;
    readonly label: string;
    /** True when the credential/env gate is satisfied (chain admission). */
    isAvailable(): boolean;
    /** Build the HTTP request for this provider. Pure. */
    buildRequest(input: VisionRequestInput): VisionHttpRequest;
    /** Parse a successful response body into analysis text. Pure. */
    parseResponse(body: string): string;
    /** Secret values this provider consulted (for redaction). */
    collectSecrets(): readonly string[];
}

// ---------------------------------------------------------------------------
// env helpers
// ---------------------------------------------------------------------------

function readEnvKey(keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Build a `data:` URI for OpenAI-style image_url / file content parts. */
function dataUri(image: VisionImage): string {
    return `data:${image.mimeType};base64,${image.base64Data}`;
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

/** openai — POST /v1/chat/completions with image_url + file content parts. */
function openaiProvider(): VisionProvider {
    const envKeys = ['OPENAI_API_KEY'] as const;
    return {
        id: 'openai',
        label: 'OpenAI',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['OPENAI_VISION_MODEL'] ?? 'gpt-4o-mini';
            const content: unknown[] = [{ type: 'text', text: input.goal }];
            for (const image of input.images) {
                if (image.mimeType === 'application/pdf') {
                    content.push({
                        type: 'file',
                        file: {
                            filename: image.filename ?? 'document.pdf',
                            file_data: dataUri(image),
                        },
                    });
                } else {
                    content.push({ type: 'image_url', image_url: { url: dataUri(image) } });
                }
            }
            return {
                url: 'https://api.openai.com/v1/chat/completions',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model,
                    max_tokens: 1024,
                    messages: [{ role: 'user', content }],
                }),
            };
        },
        parseResponse: (body) => {
            const root = asRecord(safeJsonParse(body));
            const choices = root ? asArray(root['choices']) : undefined;
            if (choices && choices.length > 0) {
                const first = asRecord(choices[0]);
                const message = first ? asRecord(first['message']) : undefined;
                const text = message ? asString(message['content']) : undefined;
                if (text !== undefined) return text;
            }
            return '';
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** anthropic — POST /v1/messages with image + document content blocks. */
function anthropicProvider(): VisionProvider {
    const envKeys = ['ANTHROPIC_API_KEY'] as const;
    return {
        id: 'anthropic',
        label: 'Anthropic',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['ANTHROPIC_VISION_MODEL'] ?? 'claude-sonnet-4-20250514';
            const content: unknown[] = [];
            for (const image of input.images) {
                const blockType = image.mimeType === 'application/pdf' ? 'document' : 'image';
                content.push({
                    type: blockType,
                    source: { type: 'base64', media_type: image.mimeType, data: image.base64Data },
                });
            }
            content.push({ type: 'text', text: input.goal });
            return {
                url: 'https://api.anthropic.com/v1/messages',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 1024,
                    messages: [{ role: 'user', content }],
                }),
            };
        },
        parseResponse: (body) => {
            const root = asRecord(safeJsonParse(body));
            const content = root ? asArray(root['content']) : undefined;
            if (content) {
                const parts: string[] = [];
                for (const block of content) {
                    const rec = asRecord(block);
                    const text = rec ? asString(rec['text']) : undefined;
                    if (text !== undefined) parts.push(text);
                }
                if (parts.length > 0) return parts.join('\n');
            }
            return '';
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** google — POST generateContent with inlineData parts. */
function googleProvider(): VisionProvider {
    const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;
    return {
        id: 'google',
        label: 'Google',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-flash';
            const parts: unknown[] = [];
            for (const image of input.images) {
                parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64Data } });
            }
            parts.push({ text: input.goal });
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts }] }),
            };
        },
        parseResponse: (body) => {
            const root = asRecord(safeJsonParse(body));
            const candidates = root ? asArray(root['candidates']) : undefined;
            if (candidates) {
                const parts: string[] = [];
                for (const candidate of candidates) {
                    const rec = asRecord(candidate);
                    const contentBlock = rec ? asRecord(rec['content']) : undefined;
                    const innerParts = contentBlock ? asArray(contentBlock['parts']) : undefined;
                    if (innerParts) {
                        for (const part of innerParts) {
                            const pr = asRecord(part);
                            const text = pr ? asString(pr['text']) : undefined;
                            if (text !== undefined) parts.push(text);
                        }
                    }
                }
                if (parts.length > 0) return parts.join('\n');
            }
            return '';
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** openrouter — OpenAI-compatible chat completions with a vision model. */
function openrouterProvider(): VisionProvider {
    const envKeys = ['OPENROUTER_API_KEY'] as const;
    return {
        id: 'openrouter',
        label: 'OpenRouter',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['OPENROUTER_VISION_MODEL'] ?? 'google/gemini-2.5-flash';
            const content: unknown[] = [{ type: 'text', text: input.goal }];
            for (const image of input.images) {
                content.push({ type: 'image_url', image_url: { url: dataUri(image) } });
            }
            return {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model,
                    max_tokens: 1024,
                    messages: [{ role: 'user', content }],
                }),
            };
        },
        parseResponse: (body) => {
            const root = asRecord(safeJsonParse(body));
            const choices = root ? asArray(root['choices']) : undefined;
            if (choices && choices.length > 0) {
                const first = asRecord(choices[0]);
                const message = first ? asRecord(first['message']) : undefined;
                const text = message ? asString(message['content']) : undefined;
                if (text !== undefined) return text;
            }
            return '';
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** zai — OpenAI-compatible chat completions targeting glm-4v vision. */
function zaiProvider(): VisionProvider {
    const envKeys = ['ZAI_API_KEY', 'ZHIPU_API_KEY'] as const;
    return {
        id: 'zai',
        label: 'Z.AI',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['ZAI_VISION_MODEL'] ?? 'glm-4v';
            const content: unknown[] = [{ type: 'text', text: input.goal }];
            for (const image of input.images) {
                content.push({ type: 'image_url', image_url: { url: dataUri(image) } });
            }
            return {
                url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model,
                    max_tokens: 1024,
                    messages: [{ role: 'user', content }],
                }),
            };
        },
        parseResponse: (body) => {
            const root = asRecord(safeJsonParse(body));
            const choices = root ? asArray(root['choices']) : undefined;
            if (choices && choices.length > 0) {
                const first = asRecord(choices[0]);
                const message = first ? asRecord(first['message']) : undefined;
                const text = message ? asString(message['content']) : undefined;
                if (text !== undefined) return text;
            }
            return '';
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

// ---------------------------------------------------------------------------
// Registry + chain resolver
// ---------------------------------------------------------------------------

function buildProviderRegistry(): readonly VisionProvider[] {
    return [openaiProvider(), anthropicProvider(), googleProvider(), openrouterProvider(), zaiProvider()];
}

const PROVIDERS: readonly VisionProvider[] = buildProviderRegistry();

export function getVisionProvider(id: VisionProviderId): VisionProvider | undefined {
    return PROVIDERS.find((provider) => provider.id === id);
}

export function allVisionProviders(): readonly VisionProvider[] {
    return PROVIDERS;
}

/**
 * Resolve the vision provider chain. When `preference` is a concrete id, that
 * provider is tried first (only if available); then the rest of the chain in
 * {@link VISION_PROVIDER_IDS} order (only those currently available). For
 * `auto`, the whole available chain is returned in order.
 */
export function resolveVisionProviderChain(preference: VisionProviderId | 'auto' = 'auto'): readonly VisionProvider[] {
    const chain: VisionProvider[] = [];
    if (preference !== 'auto') {
        const pinned = getVisionProvider(preference);
        if (pinned !== undefined && pinned.isAvailable()) {
            chain.push(pinned);
        }
    }
    for (const provider of PROVIDERS) {
        if (provider.id === preference) continue;
        if (provider.isAvailable()) {
            chain.push(provider);
        }
    }
    return chain;
}

/** Collect all secrets from available providers (for response redaction). */
export function collectVisionSecrets(): readonly string[] {
    return PROVIDERS.flatMap((provider) => provider.collectSecrets());
}
