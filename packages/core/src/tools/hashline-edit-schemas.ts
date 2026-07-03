import type { DiffFile, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { DiffFileSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { diffFileOutput } from './file-patch-schemas.js';

// A single LINE#ID-anchored edit. `lines` may be a string, a string array, or
// (for `replace` only) null/[] meaning delete the targeted line(s).
const editEntrySchema = z
    .object({
        op: z.enum(['replace', 'append', 'prepend']),
        pos: z.string().min(1).optional(),
        end: z.string().min(1).optional(),
        lines: z.union([z.string(), z.array(z.string()), z.null()]),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.op === 'replace' && (value.pos === undefined || value.pos.length === 0)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'replace requires a `pos` LINE#ID anchor (e.g. "42#VK").',
                path: ['pos'],
            });
        }
        if (value.op !== 'replace' && value.lines === null) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: '`lines: null` is only valid for replace (delete); append/prepend need content.',
                path: ['lines'],
            });
        }
        if (value.op !== 'replace' && Array.isArray(value.lines) && value.lines.length === 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: '`lines: []` is only valid for replace (delete); append/prepend need content.',
                path: ['lines'],
            });
        }
    });

export const hashlineEditInputSchema = z
    .object({
        path: z.string().min(1),
        edits: z.array(editEntrySchema),
        delete: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.delete === true && value.edits.length > 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'delete mode requires edits to be an empty array.',
                path: ['edits'],
            });
        }
        if (value.delete !== true && value.edits.length === 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'edits must be a non-empty array (or set delete: true to remove the file).',
                path: ['edits'],
            });
        }
    });
export type HashlineEditInput = z.infer<typeof hashlineEditInputSchema>;

export const hashlineEditOutputSchema = z
    .object({
        kind: z.literal('hashline_edit'),
        status: z.enum(['applied', 'deleted']),
        appliedFiles: z.array(z.string().min(1)).min(1),
        appliedEdits: z.number().int().nonnegative(),
        noopEdits: z.number().int().nonnegative(),
        deduplicatedEdits: z.number().int().nonnegative(),
        diffFiles: z.array(DiffFileSchema),
    })
    .strict();
export type HashlineEditOutput = z.infer<typeof hashlineEditOutputSchema>;

export type HashlineEditToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly allowDirtyPaths?: readonly string[];
    readonly maxModelOutputChars?: number;
};

export type ResolvedHashlineEditToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: HashlineEditToolOptions['requestPermission'];
    readonly allowDirtyPaths: readonly string[];
    readonly maxModelOutputChars: number;
};

export function resolveHashlineEditOptions(options: HashlineEditToolOptions): ResolvedHashlineEditToolOptions {
    return {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        allowDirtyPaths: options.allowDirtyPaths ?? [],
        maxModelOutputChars: options.maxModelOutputChars ?? 8192,
    };
}

export function hashlineEditParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Workspace-relative file path to edit.' },
            edits: {
                type: 'array',
                minItems: 1,
                description:
                    'LINE#ID-anchored edits. Each edit: { op: "replace"|"append"|"prepend", pos?: "NN#XX", end?: "NN#XX", lines: string|string[]|null }. Get NN#XX anchors from repo.read.tagged output. replace needs pos; lines:null or [] deletes the line/range.',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: ['replace', 'append', 'prepend'] },
                        pos: { type: 'string', description: 'Anchor like "42#VK" (line#hash). Required for replace.' },
                        end: { type: 'string', description: 'Range end anchor for multi-line replace.' },
                        lines: {
                            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }],
                            description: 'Replacement/insertion text. null (replace only) deletes.',
                        },
                    },
                    required: ['op', 'lines'],
                    additionalProperties: false,
                },
            },
            delete: { type: 'boolean', description: 'Delete the file entirely. Mutually exclusive with edits.' },
        },
        required: ['path', 'edits'],
        additionalProperties: false,
    };
}

export function hashlineEditModelOutput(output: HashlineEditOutput): string {
    if (output.status === 'deleted') {
        return `deleted ${output.appliedFiles.join(', ')}`;
    }
    const editNoun = output.appliedEdits === 1 ? 'edit' : 'edits';
    const parts = [`applied ${output.appliedEdits} ${editNoun} to ${output.appliedFiles.join(', ')}`];
    if (output.noopEdits > 0) {
        parts.push(`${output.noopEdits} no-op`);
    }
    if (output.deduplicatedEdits > 0) {
        parts.push(`${output.deduplicatedEdits} deduplicated`);
    }
    return parts.join(', ');
}

export function hashlineEditDiffOutput(diffFiles: readonly DiffFile[]): DiffFile[] {
    return diffFileOutput(diffFiles);
}
