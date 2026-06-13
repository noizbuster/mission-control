import type { DiffFile, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { DiffFileSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { diffFileOutput } from './file-patch-schemas.js';

export const fileWriteInputSchema = z
    .object({
        path: z.string().min(1),
        content: z.string(),
        createParents: z.boolean().optional(),
    })
    .strict();
export type FileWriteInput = z.infer<typeof fileWriteInputSchema>;

export const fileWriteOutputSchema = z
    .object({
        kind: z.literal('file_write'),
        status: z.literal('applied'),
        operation: z.enum(['created', 'replaced']),
        appliedFiles: z.tuple([z.string().min(1)]),
        createdParentDirectories: z.array(z.string().min(1)),
        diffFiles: z.array(DiffFileSchema).length(1),
    })
    .strict();
export type FileWriteOutput = z.infer<typeof fileWriteOutputSchema>;

export type FileWriteToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly allowDirtyPaths?: readonly string[];
    readonly maxModelOutputChars?: number;
};

export type ResolvedFileWriteToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: FileWriteToolOptions['requestPermission'];
    readonly allowDirtyPaths: readonly string[];
    readonly maxModelOutputChars: number;
};

export function resolveFileWriteOptions(options: FileWriteToolOptions): ResolvedFileWriteToolOptions {
    return {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        allowDirtyPaths: options.allowDirtyPaths ?? [],
        maxModelOutputChars: options.maxModelOutputChars ?? 8192,
    };
}

export function fileWriteParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Workspace-relative file path to create or replace.' },
            content: { type: 'string', description: 'Full UTF-8 text file contents to write.' },
            createParents: {
                type: 'boolean',
                description: 'Create missing parent directories for a new file target.',
            },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    };
}

export function fileWriteModelOutput(output: {
    readonly operation: 'created' | 'replaced';
    readonly appliedFiles: readonly string[];
}): string {
    const verb = output.operation === 'created' ? 'created' : 'replaced';
    return `${verb} ${output.appliedFiles.join(', ')}`;
}

export function fileWriteDiffOutput(diffFiles: readonly DiffFile[]): DiffFile[] {
    return diffFileOutput(diffFiles);
}
