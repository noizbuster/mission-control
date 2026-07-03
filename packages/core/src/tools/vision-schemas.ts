/**
 * Shared schemas + types for the vision tools (look_at, inspect_image).
 *
 * The vision provider IDs and the credential-env hint message live here so the
 * tool layer and the provider chain share one source of truth.
 */
import { z } from 'zod';

export const VISION_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'openrouter', 'zai'] as const;
export type VisionProviderId = (typeof VISION_PROVIDER_IDS)[number];

export const visionProviderIdSchema = z.enum(VISION_PROVIDER_IDS);

/**
 * Human-readable list of the env vars that admit the vision chain. Used in the
 * no-credential gate error so the model (and the user) sees exactly which keys
 * would unlock the tool.
 */
export function visionCredentialHint(): string {
    return [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY (or GOOGLE_API_KEY)',
        'OPENROUTER_API_KEY',
        'ZAI_API_KEY (or ZHIPU_API_KEY)',
    ].join(', ');
}
