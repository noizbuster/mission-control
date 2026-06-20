import type { DiffFile, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { DiffFileSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { diffFileOutput } from './file-patch-schemas.js';

export const fileEditInputSchema = z
    .object({
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        occurrence: z.number().int().positive().optional(),
        replaceAll: z.boolean().optional(),
        matchStrategy: z.enum(['exact', 'fuzzy']).optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.occurrence !== undefined && value.replaceAll !== undefined) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'occurrence and replaceAll are mutually exclusive',
                path: ['occurrence'],
            });
        }
        if (value.oldText === value.newText) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'oldText and newText must differ',
                path: ['newText'],
            });
        }
    });
export type FileEditInput = z.infer<typeof fileEditInputSchema>;

export const fileEditOutputSchema = z
    .object({
        kind: z.literal('file_edit'),
        status: z.literal('applied'),
        appliedFiles: z.tuple([z.string().min(1)]),
        occurrencesReplaced: z.number().int().positive(),
        diffFiles: z.array(DiffFileSchema).length(1),
    })
    .strict();
export type FileEditOutput = z.infer<typeof fileEditOutputSchema>;

export type FileEditToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly allowDirtyPaths?: readonly string[];
    readonly maxModelOutputChars?: number;
};

export type ResolvedFileEditToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: FileEditToolOptions['requestPermission'];
    readonly allowDirtyPaths: readonly string[];
    readonly maxModelOutputChars: number;
};

export function resolveFileEditOptions(options: FileEditToolOptions): ResolvedFileEditToolOptions {
    return {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        allowDirtyPaths: options.allowDirtyPaths ?? [],
        maxModelOutputChars: options.maxModelOutputChars ?? 8192,
    };
}

export function fileEditParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Workspace-relative file path to edit.' },
            oldText: { type: 'string', description: 'Exact text to replace. Must match literally.' },
            newText: { type: 'string', description: 'Replacement text.' },
            occurrence: {
                type: 'integer',
                minimum: 1,
                description: '1-based occurrence index to replace when multiple exact matches exist.',
            },
            replaceAll: {
                type: 'boolean',
                description: 'Replace every exact match. Mutually exclusive with occurrence.',
            },
            matchStrategy: {
                type: 'string',
                enum: ['exact', 'fuzzy'],
                description:
                    "Matching strategy. Omit for exact-first then fuzzy fallback (default). 'exact' disables the fuzzy fallback entirely for strict matching. 'fuzzy' matches the default exact-first fallback behavior.",
            },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
    };
}

export function fileEditModelOutput(output: {
    readonly appliedFiles: readonly string[];
    readonly occurrencesReplaced: number;
}): string {
    const noun = output.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
    return `replaced ${output.occurrencesReplaced} ${noun} in ${output.appliedFiles.join(', ')}`;
}

export function fileEditDiffOutput(diffFiles: readonly DiffFile[]): DiffFile[] {
    return diffFileOutput(diffFiles);
}
