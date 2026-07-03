/**
 * Media tool schemas (`generate_image`, `tts`) — checkbox #33 port-ref-tools.
 *
 * These schemas define the cross-boundary contract for the credential-gated
 * media tool seams. Media is NEVER inlined: both outputs expose only on-disk
 * artifact paths (plus provider/codec metadata). Raw image/audio bytes stay
 * internal to the tool execute function and are written to the artifacts dir
 * before the result is serialized.
 *
 * Ported from oh-my-pi `image-gen.ts` / `tts.ts` (MIT) as a lean seam: the
 * schema surface, credential gate, and artifact-writing output shape. The full
 * multi-provider HTTP machinery is replaced by an injectable transport seam in
 * `@mission-control/core` so tests can mock the provider without live calls.
 */
import { z } from 'zod';

// --- generate_image -------------------------------------------------------

export const MEDIA_IMAGE_PROVIDER_IDS = ['gemini', 'openai', 'xai'] as const;
export type MediaImageProviderId = (typeof MEDIA_IMAGE_PROVIDER_IDS)[number];

export const MEDIA_IMAGE_PROVIDER_PREFERENCE = ['auto', ...MEDIA_IMAGE_PROVIDER_IDS] as const;
export type MediaImageProviderPreference = (typeof MEDIA_IMAGE_PROVIDER_PREFERENCE)[number];

export const MEDIA_IMAGE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export type MediaImageAspectRatio = (typeof MEDIA_IMAGE_ASPECT_RATIOS)[number];

export const MEDIA_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export type MediaImageSize = (typeof MEDIA_IMAGE_SIZES)[number];

/**
 * A reference image for edits. At most one of `path` / `data` is provided.
 * `path` resolves relative to the workspace; `data` is raw base64 with an
 * explicit `mime_type` (this is tool *input*, not inlined tool *output*).
 */
export const generateImageInputImageSchema = z
    .object({
        path: z.string().min(1).optional(),
        data: z.string().min(1).optional(),
        mime_type: z.string().min(1).optional(),
    })
    .strict();
export type GenerateImageInputImage = z.infer<typeof generateImageInputImageSchema>;

export const generateImageInputSchema = z
    .object({
        prompt: z.string().min(1).describe('Image generation or edit prompt.'),
        provider: z.enum(MEDIA_IMAGE_PROVIDER_PREFERENCE).optional(),
        aspect_ratio: z.enum(MEDIA_IMAGE_ASPECT_RATIOS).optional(),
        image_size: z.enum(MEDIA_IMAGE_SIZES).optional(),
        input: z.array(generateImageInputImageSchema).optional(),
        /** Override the artifacts directory; defaults to the media artifacts dir. */
        output_dir: z.string().min(1).optional(),
    })
    .strict();
export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

/**
 * `generate_image` output. `image_paths` are on-disk artifact paths only —
 * raw image bytes are NEVER inlined here or in any event.
 */
export const generateImageOutputSchema = z
    .object({
        image_paths: z.array(z.string()).min(1),
        provider: z.string(),
        model: z.string(),
        count: z.number().int().nonnegative(),
    })
    .strict();
export type GenerateImageOutput = z.infer<typeof generateImageOutputSchema>;

// --- tts -----------------------------------------------------------------

export const MEDIA_TTS_CODECS = ['mp3', 'wav'] as const;
export type MediaTtsCodec = (typeof MEDIA_TTS_CODECS)[number];

export const ttsInputSchema = z
    .object({
        text: z.string().min(1).max(15_000),
        voice_id: z.string().min(1),
        language: z.string().min(1),
        output_path: z.string().min(1),
        sample_rate: z.number().int().positive().optional(),
        bit_rate: z.number().int().positive().optional(),
    })
    .strict();
export type TtsInput = z.infer<typeof ttsInputSchema>;

/**
 * `tts` output. `audio_path` is an on-disk artifact path only — raw audio
 * bytes are NEVER inlined here or in any event.
 */
export const ttsOutputSchema = z
    .object({
        audio_path: z.string(),
        bytes: z.number().int().nonnegative(),
        voice_id: z.string(),
        codec: z.enum(MEDIA_TTS_CODECS),
        backend: z.string(),
    })
    .strict();
export type TtsOutput = z.infer<typeof ttsOutputSchema>;
