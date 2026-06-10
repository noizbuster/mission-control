import type { DiffFile, DiffLine, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { DiffFileSchema } from '@mission-control/protocol';
import { z } from 'zod';

const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';
const TOKEN_LIKE_SECRET_PATTERN = /sk-[A-Za-z0-9_-]+/g;

export const filePatchInputSchema = z
    .object({
        patch: z.string().min(1),
    })
    .strict();
export type FilePatchInput = z.infer<typeof filePatchInputSchema>;

export const filePatchOutputSchema = z
    .object({
        kind: z.literal('file_patch'),
        status: z.literal('applied'),
        appliedFiles: z.array(z.string().min(1)),
        diffFiles: z.array(DiffFileSchema),
    })
    .strict();
export type FilePatchOutput = z.infer<typeof filePatchOutputSchema>;

export type FilePatchToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly allowDirtyPaths?: readonly string[];
    readonly maxPatchBytes?: number;
    readonly maxModelOutputChars?: number;
};

export type ResolvedFilePatchToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: FilePatchToolOptions['requestPermission'];
    readonly allowDirtyPaths: readonly string[];
    readonly maxPatchBytes: number;
    readonly maxModelOutputChars: number;
};

export function resolveFilePatchOptions(options: FilePatchToolOptions): ResolvedFilePatchToolOptions {
    return {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        allowDirtyPaths: options.allowDirtyPaths ?? [],
        maxPatchBytes: options.maxPatchBytes ?? 256 * 1024,
        maxModelOutputChars: options.maxModelOutputChars ?? 8192,
    };
}

export function filePatchParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            patch: { type: 'string', description: 'Unified diff patch to apply.' },
        },
        required: ['patch'],
        additionalProperties: false,
    };
}

export function filePatchModelOutput(output: { readonly appliedFiles: readonly string[] }): string {
    return `applied patch to ${output.appliedFiles.join(', ')}`;
}

export function diffFileOutput(diffFiles: readonly DiffFile[]): DiffFile[] {
    return diffFiles.map((diffFile) => ({
        ...diffFile,
        hunks: diffFile.hunks.map((hunk) => ({
            ...hunk,
            lines: hunk.lines.map(redactDiffLine),
        })),
    }));
}

function redactDiffLine(line: DiffLine): DiffLine {
    const content = line.content.replace(TOKEN_LIKE_SECRET_PATTERN, REDACTED_CREDENTIAL);
    if (content === line.content) {
        return { ...line };
    }
    return { ...line, content, redacted: true };
}
