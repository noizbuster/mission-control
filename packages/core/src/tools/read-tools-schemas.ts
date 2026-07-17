import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import type { NativesClient } from '../native/natives-client';
import type { SchemeResolver } from './scheme-resolver';

/** Default line window when the model omits `limit` (OpenCode parity). */
export const DEFAULT_READ_LINE_LIMIT = 2000;

export const readInputSchema = z
    .object({
        path: z.string().min(1),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        // Opt-in structural summary: only when the model sets `summary: true`
        // and the native addon can parse the language. Default reads return
        // raw line windows (offset/limit) so the model can search and inspect
        // bodies. Unsupported languages, parse failures, and line-windowed
        // reads always stay raw regardless of this flag.
        summary: z.boolean().optional(),
        // Opt-in: tag every line with a `NN#XX|` content-hash anchor so a
        // follow-up `hashline_edit` can reference lines by `NN#XX` and reject
        // stale content. Untagged reads (the default) are byte-identical to
        // pre-tagged behavior; this flag never alters the default path.
        tagged: z.boolean().optional(),
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
        // Present and `true` only when the content is a structural summary
        // (bodies elided) rather than the verbatim source.
        summarized: z.boolean().optional(),
        // Number of source lines collapsed into elision markers; present only
        // when `summarized` is true.
        elidedLines: z.number().int().nonnegative().optional(),
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
    readonly requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly maxReadBytes?: number;
    readonly maxListEntries?: number;
    readonly maxSearchMatches?: number;
    readonly maxSearchLineChars?: number;
    readonly maxModelOutputChars?: number;
    readonly allowDenylistedPaths?: readonly string[];
    readonly natives?: NativesClient;
    readonly schemeResolver?: SchemeResolver;
};

export type ResolvedReadOnlyRepoToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly maxReadBytes: number;
    readonly maxListEntries: number;
    readonly maxSearchMatches: number;
    readonly maxSearchLineChars: number;
    readonly maxModelOutputChars: number;
    readonly allowDenylistedPaths: readonly string[];
    readonly natives?: NativesClient;
    readonly schemeResolver?: SchemeResolver;
};

export function readModelOutput(output: ReadOutput): string {
    const emptyWindow =
        output.content.length === 0 && output.truncated
            ? '\n\n[empty window: offset is past the loaded content; lower offset or raise limit, or re-read without offset from the start]'
            : '';
    const suffix = output.truncated
        ? `\n\n[truncated: ${output.returnedBytes} of ${output.originalBytes} bytes returned; re-read with offset/limit for another window]`
        : '';
    const summaryNote =
        output.summarized === true && output.elidedLines !== undefined
            ? `\n\n[structural summary: ${output.elidedLines} line${output.elidedLines === 1 ? '' : 's'} elided; re-read without summary (or with offset/limit) for the raw source]`
            : '';
    return `${output.path}\n${output.content}${emptyWindow}${suffix}${summaryNote}`;
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
        workspaceRoot: options.workspaceRoot,
        ...(options.requestPermission !== undefined ? { requestPermission: options.requestPermission } : {}),
        maxReadBytes: options.maxReadBytes ?? 50 * 1024,
        maxListEntries: options.maxListEntries ?? 500,
        maxSearchMatches: options.maxSearchMatches ?? 100,
        maxSearchLineChars: options.maxSearchLineChars ?? 500,
        maxModelOutputChars: options.maxModelOutputChars ?? 8 * 1024,
        allowDenylistedPaths: options.allowDenylistedPaths ?? [],
        ...(options.natives !== undefined ? { natives: options.natives } : {}),
        ...(options.schemeResolver !== undefined ? { schemeResolver: options.schemeResolver } : {}),
    };
}

export function readParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Workspace-relative or absolute path to a text file to read.',
            },
            offset: {
                type: 'number',
                minimum: 1,
                description: '1-indexed line number to start reading from. Omit to start at line 1.',
            },
            limit: {
                type: 'number',
                minimum: 1,
                description: `Maximum number of lines to return (default ${DEFAULT_READ_LINE_LIMIT}). Use with offset to page through large files.`,
            },
            summary: {
                type: 'boolean',
                description:
                    'Opt-in structural summary (imports + signatures, bodies elided) for supported languages when the native addon is available. Default false returns the raw line window. Prefer offset/limit over summary when you need function bodies.',
            },
            tagged: {
                type: 'boolean',
                description:
                    'Opt-in: prefix every line with a `NN#XX|` content-hash anchor for use with hashline_edit. Default false returns the raw text unchanged.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    };
}

export function listParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Workspace-relative directory to list. Defaults to the workspace root.',
            },
        },
        additionalProperties: false,
    };
}

export function searchParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Regex pattern to search for in file contents (RE2-style; no lookaround).',
            },
            path: {
                type: 'string',
                description:
                    'File or directory to search under. Defaults to the workspace root. Pass a single file path to search only that file.',
            },
            include: {
                type: 'string',
                description: 'File suffix/glob filter for matches (e.g. "*.ts", "*.tsx", "*.md").',
            },
        },
        required: ['pattern'],
        additionalProperties: false,
    };
}
