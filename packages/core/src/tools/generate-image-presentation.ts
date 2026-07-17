import type { GenerateImageOutput } from '@mission-control/protocol';
import { MEDIA_IMAGE_PROVIDER_PREFERENCE } from '@mission-control/protocol';

export function generateImageModelOutput(output: GenerateImageOutput): string {
    const lines = [
        `generate_image: provider=${output.provider} model=${output.model} (${output.count} image${output.count === 1 ? '' : 's'})`,
        ...output.image_paths.map((path) => `  ${path}`),
    ];
    return lines.join('\n');
}

export function noImageCredentialMessage(): string {
    return 'No image generation credential configured. Set one of GEMINI_API_KEY (or GOOGLE_API_KEY), OPENAI_API_KEY, or XAI_API_KEY.';
}

export function generateImageParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Image generation or edit prompt.' },
            provider: {
                type: 'string',
                enum: [...MEDIA_IMAGE_PROVIDER_PREFERENCE],
                description: "'auto' (default) uses the first configured provider; pin to gemini, openai, or xai.",
            },
            aspect_ratio: {
                type: 'string',
                enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
                description: 'Output aspect ratio.',
            },
            image_size: {
                type: 'string',
                enum: ['1024x1024', '1536x1024', '1024x1536'],
                description: 'Output pixel dimensions.',
            },
            input: {
                type: 'array',
                description: 'Reference images for edits. Each entry has path or base64 data plus mime_type.',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        data: { type: 'string', description: 'base64-encoded image bytes' },
                        mime_type: { type: 'string' },
                    },
                },
            },
            output_dir: { type: 'string', description: 'Override the artifacts directory.' },
        },
        required: ['prompt'],
        additionalProperties: false,
    };
}
