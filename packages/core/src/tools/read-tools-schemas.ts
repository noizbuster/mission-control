import { z } from 'zod';

export const readInputSchema = z
    .object({
        path: z.string().min(1),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
    })
    .strict();

export const listInputSchema = z
    .object({
        path: z.string().min(1).optional(),
    })
    .strict();

export const searchInputSchema = z
    .object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        include: z.string().min(1).optional(),
    })
    .strict();

export const readOutputSchema = z
    .object({
        kind: z.literal('file'),
        path: z.string(),
        content: z.string(),
        truncated: z.boolean(),
        originalBytes: z.number().int().nonnegative(),
        returnedBytes: z.number().int().nonnegative(),
    })
    .strict();

export const listOutputSchema = z
    .object({
        kind: z.literal('directory'),
        path: z.string(),
        entries: z.array(
            z.object({ name: z.string(), kind: z.enum(['file', 'directory', 'symlink', 'other']) }).strict(),
        ),
        truncated: z.boolean(),
        totalEntries: z.number().int().nonnegative(),
    })
    .strict();

export const searchOutputSchema = z
    .object({
        kind: z.literal('search'),
        pattern: z.string(),
        path: z.string(),
        matches: z.array(
            z
                .object({
                    path: z.string(),
                    line: z.number().int().positive(),
                    text: z.string(),
                    textTruncated: z.boolean(),
                })
                .strict(),
        ),
        truncated: z.boolean(),
        totalMatches: z.number().int().nonnegative(),
    })
    .strict();

export type ReadInput = z.infer<typeof readInputSchema>;
export type ListInput = z.infer<typeof listInputSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;
export type ListOutput = z.infer<typeof listOutputSchema>;
export type SearchOutput = z.infer<typeof searchOutputSchema>;

export type ReadOnlyRepoToolOptions = {
    readonly workspaceRoot: string;
    readonly maxReadBytes?: number;
    readonly maxListEntries?: number;
    readonly maxSearchMatches?: number;
    readonly maxSearchLineChars?: number;
    readonly maxModelOutputChars?: number;
    readonly allowDenylistedPaths?: readonly string[];
};

export type ResolvedReadOnlyRepoToolOptions = {
    readonly maxReadBytes: number;
    readonly maxListEntries: number;
    readonly maxSearchMatches: number;
    readonly maxSearchLineChars: number;
    readonly maxModelOutputChars: number;
    readonly allowDenylistedPaths: readonly string[];
};

export function readModelOutput(output: ReadOutput): string {
    const suffix = output.truncated
        ? `\n\n[truncated: ${output.returnedBytes} of ${output.originalBytes} bytes returned]`
        : '';
    return `${output.path}\n${output.content}${suffix}`;
}

export function searchModelOutput(output: SearchOutput): string {
    if (output.matches.length === 0) {
        return `No matches for ${output.pattern}`;
    }
    const rows = output.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
    if (output.truncated) {
        rows.push(`[truncated: ${output.matches.length} of ${output.totalMatches} matches returned]`);
    }
    return rows.join('\n');
}

export function resolveOptions(options: ReadOnlyRepoToolOptions): ResolvedReadOnlyRepoToolOptions {
    return {
        maxReadBytes: options.maxReadBytes ?? 50 * 1024,
        maxListEntries: options.maxListEntries ?? 500,
        maxSearchMatches: options.maxSearchMatches ?? 100,
        maxSearchLineChars: options.maxSearchLineChars ?? 500,
        maxModelOutputChars: options.maxModelOutputChars ?? 8 * 1024,
        allowDenylistedPaths: options.allowDenylistedPaths ?? [],
    };
}

export function readParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: { type: 'string' },
            offset: { type: 'number', minimum: 1 },
            limit: { type: 'number', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
    };
}

export function listParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: { type: 'string' },
        },
        additionalProperties: false,
    };
}

export function searchParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            include: { type: 'string' },
        },
        required: ['pattern'],
        additionalProperties: false,
    };
}
