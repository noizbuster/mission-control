import type { MediaImageProviderId } from '@mission-control/protocol';
import { decodeImageBase64 } from './generate-image-bytes';
import type {
    GeneratedImageBytes,
    GenerateImageTransport,
    ImageCredentialResolver,
    ResolvedImageCredential,
} from './generate-image-tool';

const DEFAULT_MODELS = {
    gemini: 'gemini-3-pro-image-preview',
    openai: 'gpt-image-1',
    xai: 'grok-imagine-image',
} as const satisfies Record<MediaImageProviderId, string>;

export function createEnvImageCredentialResolver(
    env: Readonly<Record<string, string | undefined>> = process.env,
): ImageCredentialResolver {
    return async () => {
        const geminiKey = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'];
        if (geminiKey !== undefined && geminiKey.length > 0) {
            return { provider: 'gemini', apiKey: geminiKey, model: DEFAULT_MODELS.gemini };
        }
        const openaiKey = env['OPENAI_API_KEY'];
        if (openaiKey !== undefined && openaiKey.length > 0) {
            return { provider: 'openai', apiKey: openaiKey, model: DEFAULT_MODELS.openai };
        }
        const xaiKey = env['XAI_API_KEY'];
        if (xaiKey !== undefined && xaiKey.length > 0) {
            return { provider: 'xai', apiKey: xaiKey, model: DEFAULT_MODELS.xai };
        }
        return undefined;
    };
}

export const defaultImageTransport: GenerateImageTransport = {
    async generate(input, credential, signal) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (credential.provider === 'gemini') headers['x-goog-api-key'] = credential.apiKey;
        else headers['Authorization'] = `Bearer ${credential.apiKey}`;
        const response = await fetch(defaultImageEndpoint(credential), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                prompt: input.prompt,
                ...(input.aspectRatio !== undefined ? { aspect_ratio: input.aspectRatio } : {}),
                ...(input.imageSize !== undefined ? { image_size: input.imageSize } : {}),
            }),
            signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(
                `${credential.provider} image request failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
            );
        }
        const payload = (await response.json()) as { data?: Array<{ b64_json?: string; mime_type?: string }> };
        const images: GeneratedImageBytes[] = [];
        for (const entry of payload.data ?? []) {
            if (entry.b64_json !== undefined) {
                images.push({
                    bytes: decodeImageBase64(entry.b64_json),
                    mimeType: entry.mime_type ?? 'image/png',
                });
            }
        }
        if (images.length === 0) throw new Error(`${credential.provider} returned no image bytes`);
        return images;
    },
};

function defaultImageEndpoint(credential: ResolvedImageCredential): string {
    switch (credential.provider) {
        case 'gemini':
            return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(credential.model)}:generateContent`;
        case 'openai':
            return 'https://api.openai.com/v1/images/generations';
        case 'xai':
            return 'https://api.x.ai/v1/images/generations';
        default:
            return assertNeverProvider(credential.provider);
    }
}

function assertNeverProvider(provider: never): never {
    throw new Error(`Unexpected image provider: ${String(provider)}`);
}
