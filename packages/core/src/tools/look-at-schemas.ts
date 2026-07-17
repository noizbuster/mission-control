import { z } from 'zod';

export const lookAtInputSchema = z
    .object({
        file_path: z.string().min(1).optional(),
        file_paths: z.array(z.string().min(1)).optional(),
        image_data: z.string().min(1).optional(),
        image_data_list: z.array(z.string().min(1)).optional(),
        goal: z.string().min(1),
    })
    .strict();
export type LookAtInput = z.infer<typeof lookAtInputSchema>;

export const lookAtOutputSchema = z
    .object({
        kind: z.literal('look_at'),
        provider: z.string(),
        goal: z.string(),
        sourceDescription: z.string(),
        analysis: z.string(),
        truncated: z.boolean(),
        originalLength: z.number().int().nonnegative(),
        returnedLength: z.number().int().nonnegative(),
    })
    .strict();
export type LookAtOutput = z.infer<typeof lookAtOutputSchema>;

export function lookAtParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to analyze.' },
            file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths to multiple files to analyze together.',
            },
            image_data: {
                type: 'string',
                description: 'Base64-encoded image data (for clipboard/pasted images). May include a data: prefix.',
            },
            image_data_list: {
                type: 'array',
                items: { type: 'string' },
                description: 'Base64-encoded image data entries (for multiple clipboard/pasted images).',
            },
            goal: { type: 'string', description: 'What specific information to extract from the file(s).' },
        },
        required: ['goal'],
        additionalProperties: false,
    };
}
