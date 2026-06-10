import { z } from 'zod';

export const DIFF_LINE_KINDS = ['context', 'added', 'removed'] as const;
export const DIFF_CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const;

export const DiffLineKindSchema = z.enum(DIFF_LINE_KINDS);
export type DiffLineKind = z.infer<typeof DiffLineKindSchema>;

export const DiffChangeKindSchema = z.enum(DIFF_CHANGE_KINDS);
export type DiffChangeKind = z.infer<typeof DiffChangeKindSchema>;

export const DiffLineSchema = z
    .object({
        kind: DiffLineKindSchema,
        content: z.string(),
        redacted: z.literal(true).optional(),
    })
    .strict();
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffHunkSchema = z
    .object({
        oldStart: z.number().int().positive(),
        oldLines: z.number().int().nonnegative(),
        newStart: z.number().int().positive(),
        newLines: z.number().int().nonnegative(),
        lines: z.array(DiffLineSchema).min(1),
    })
    .strict();
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileSchema = z
    .object({
        filePath: z.string().min(1),
        changeKind: DiffChangeKindSchema,
        oldFilePath: z.string().min(1).optional(),
        hunks: z.array(DiffHunkSchema).min(1),
    })
    .strict();
export type DiffFile = z.infer<typeof DiffFileSchema>;
