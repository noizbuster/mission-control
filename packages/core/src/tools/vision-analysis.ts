import { redactCredentialText } from '../providers/credential-resolver';
import { lookAtFailure } from './look-at-errors';
import { ToolExecutionError } from './tool-registry';
import {
    collectVisionSecrets,
    resolveVisionProviderChain,
    type VisionHttpRequest,
    type VisionImage,
} from './vision-providers';
import type { VisionProviderId } from './vision-schemas';
import { visionCredentialHint } from './vision-schemas';

export type VisionFetchFn = (request: VisionHttpRequest, signal: AbortSignal) => Promise<{ readonly body: string }>;

export const defaultVisionFetch: VisionFetchFn = async (request, signal) => {
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw lookAtFailure(
            `vision provider returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
            true,
        );
    }
    return { body: await response.text() };
};

export async function runVisionAnalysis(
    images: readonly VisionImage[],
    goal: string,
    preference: VisionProviderId | 'auto',
    fetchFn: VisionFetchFn,
    signal: AbortSignal,
): Promise<string> {
    const chain = resolveVisionProviderChain(preference);
    if (chain.length === 0) {
        throw lookAtFailure(
            `No vision provider credential is configured. Set one of: ${visionCredentialHint()}.`,
            false,
        );
    }
    const secrets = collectVisionSecrets();
    let lastError: Error | undefined;
    for (const provider of chain) {
        try {
            const response = await fetchFn(provider.buildRequest({ goal, images }), signal);
            const analysis = provider.parseResponse(response.body);
            if (analysis.length === 0) throw lookAtFailure(`${provider.label} returned an empty analysis`, true);
            return redactCredentialText(analysis, secrets);
        } catch (error: unknown) {
            if (error instanceof ToolExecutionError && !error.error.retryable) throw error;
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw lookAtFailure(`all vision providers failed${lastError !== undefined ? `: ${lastError.message}` : ''}`, true);
}
