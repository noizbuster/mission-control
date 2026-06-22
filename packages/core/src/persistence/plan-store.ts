import { OmoPersistenceError } from './paths.js';
import { readFile } from 'node:fs/promises';

/**
 * Matches a top-level (column 0) markdown task list checkbox:
 *   `- [ ]` (unchecked) or `- [x]` / `- [X]` (checked).
 * Indented/nested checkboxes are intentionally excluded because they start
 * with whitespace and cannot match `^`.
 */
const TOP_LEVEL_CHECKBOX = /^- \[(?<checked>[ xX])\] (?<text>.*)$/u;

export type PlanChecklistItem = {
    readonly checked: boolean;
    readonly text: string;
    readonly lineNumber: number;
};

export type PlanChecklist = {
    readonly total: number;
    readonly completed: number;
    readonly unchecked: number;
    readonly items: readonly PlanChecklistItem[];
};

export class PlanStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'PlanStoreError';
    }
}

/**
 * Read a plan markdown file as raw text. Throws `PlanStoreError`
 * ({ code: 'plan_read_failed' }) on I/O failure.
 */
export async function readPlan(planPath: string): Promise<string> {
    try {
        return await readFile(planPath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            throw new PlanStoreError(`Plan file not found at ${planPath}`, 'plan_missing', planPath, error);
        }
        throw new PlanStoreError(`Failed to read plan at ${planPath}`, 'plan_read_failed', planPath, error);
    }
}

/**
 * Parse a plan markdown file and count top-level checkboxes.
 *
 * A "top-level" checkbox is a line matching `/^- \[[ xX]\] /` at column 0
 * (no leading whitespace). Nested/indented checkboxes are not counted. Lines
 * inside fenced code blocks are still counted; this is an intentional
 * line-scan, not a markdown AST walk.
 *
 * Plans that use `### Task` headers instead of checkboxes return
 * `{ total: 0, completed: 0, unchecked: 0, items: [] }`.
 */
export async function parsePlanChecklist(planPath: string): Promise<PlanChecklist> {
    const contents = await readPlan(planPath);
    return parsePlanChecklistText(contents);
}

export function parsePlanChecklistText(contents: string): PlanChecklist {
    const lines = contents.split(/\r?\n/u);
    const items: PlanChecklistItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) {
            continue;
        }
        const match = TOP_LEVEL_CHECKBOX.exec(line);
        const groups = match?.groups;
        if (groups === undefined) {
            continue;
        }
        // biome-ignore lint/complexity/useLiteralKeys: RegExpMatchArray.groups is an index signature requiring bracket access under noPropertyAccessFromIndexSignature
        const checkedRaw = groups['checked'];
        // biome-ignore lint/complexity/useLiteralKeys: RegExpMatchArray.groups is an index signature requiring bracket access under noPropertyAccessFromIndexSignature
        const textRaw = groups['text'];
        if (checkedRaw === undefined || textRaw === undefined) {
            continue;
        }
        items.push({
            checked: checkedRaw.toLowerCase() === 'x',
            text: textRaw,
            lineNumber: index + 1,
        });
    }
    const completed = items.filter((item) => item.checked).length;
    const unchecked = items.length - completed;
    return { total: items.length, completed, unchecked, items };
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
