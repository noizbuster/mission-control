import { McPersistenceError } from './paths';
import { readFile } from 'node:fs/promises';

/**
 * Matches a top-level (column 0) markdown task list checkbox:
 *   `- [ ]` (unchecked) or `- [x]` / `- [X]` (checked).
 * Indented/nested checkboxes are intentionally excluded because they start
 * with whitespace and cannot match `^`.
 */
const TOP_LEVEL_CHECKBOX = /^- \[(?<checked>[ xX])\] (?<text>.*)$/u;

/**
 * Matches a level-two markdown heading (`## ...`) and captures the heading
 * text. Used by the section-scoped checklist parser to track which section a
 * checkbox falls under. Level-one (`#`) and level-three+ (`###`) headings do
 * NOT match; only `##` boundaries change the active section.
 */
const LEVEL_TWO_HEADING = /^## (?<heading>.+)$/u;

/**
 * Counted section headings (case-insensitive). Only column-0 checkboxes under
 * these headings contribute to the plan progress tally. `## Todos` / `## TODOs`
 * covers both the planner scaffold heading and the reference boulder-state
 * convention; `## Final Verification Wave` is the runner's final gate. Mirrors
 * the reference boulder-state `parsePlanChecklist` contract.
 */
const COUNTED_TODOS_HEADING = /^todos$/iu;
const COUNTED_FINAL_WAVE_HEADING = /^final verification wave$/iu;

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
    /**
     * Label (checkbox text) of the first unchecked counted todo, or `null`
     * when every counted checkbox is checked or there are no counted
     * checkboxes. Surfaced so the runner can name the next task to delegate
     * without re-scanning the plan.
     */
    readonly nextTaskLabel: string | null;
};

export class PlanStoreError extends McPersistenceError {
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
 * Parse a plan markdown file and count section-scoped top-level checkboxes.
 *
 * Delegates to `parsePlanChecklistText` (section-scoped). See that function
 * for the counting rules.
 */
export async function parsePlanChecklist(planPath: string): Promise<PlanChecklist> {
    const contents = await readPlan(planPath);
    return parsePlanChecklistText(contents);
}

/**
 * Parse plan markdown and count top-level checkboxes, scoped to actionable
 * sections.
 *
 * Section scoping (mirrors the reference boulder-state
 * `parsePlanChecklist`): only column-0 checkboxes (`- [ ]` / `- [x]`) that fall
 * under a `## Todos` / `## TODOs` or `## Final Verification Wave` heading are
 * counted. Checkboxes before any heading, under `## Notes`, `## Acceptance
 * Criteria`, `## Evidence`, `## Definition of Done`, or any other section are
 * IGNORED. Nested/indented checkboxes are never counted regardless of section.
 *
 * Fallback: when the markdown contains NO counted section heading at all, every
 * column-0 checkbox is counted. This keeps heading-less plans (and code-fence
 * fixtures) backward-compatible: a plan with no `## Todos` heading is treated
 * as fully actionable rather than empty.
 *
 * Lines inside fenced code blocks are still counted; this is an intentional
 * line-scan, not a markdown AST walk.
 *
 * `nextTaskLabel` is the text of the first unchecked counted checkbox, or
 * `null` when all are checked.
 */
export function parsePlanChecklistText(contents: string): PlanChecklist {
    return scanPlanChecklist(contents);
}

/**
 * Explicit section-scoped plan parser. Functionally identical to
 * `parsePlanChecklistText` (both apply the same section-scoped scan with the
 * no-counted-heading fallback). Exported under a distinct name so the runner
 * workflow graph and its tests can reference the section-scoped contract
 * explicitly without coupling to the legacy function name.
 */
export function parsePlanSections(contents: string): PlanChecklist {
    return scanPlanChecklist(contents);
}

function scanPlanChecklist(contents: string): PlanChecklist {
    const lines = contents.split(/\r?\n/u);
    const hasCountedSections = lines.some(isCountedSectionHeadingLine);
    const items: PlanChecklistItem[] = [];
    // No counted heading anywhere: treat the whole document as actionable so heading-less plans still tally.
    let inCountedSection = !hasCountedSections;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) {
            continue;
        }
        const headingText = extractLevelTwoHeading(line);
        if (headingText !== null) {
            inCountedSection = isCountedHeading(headingText);
            continue;
        }
        if (!inCountedSection) {
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
    const firstUnchecked = items.find((item) => !item.checked);
    return {
        total: items.length,
        completed,
        unchecked,
        items,
        nextTaskLabel: firstUnchecked === undefined ? null : firstUnchecked.text,
    };
}

function isCountedSectionHeadingLine(line: string): boolean {
    const headingText = extractLevelTwoHeading(line);
    return headingText !== null && isCountedHeading(headingText);
}

function extractLevelTwoHeading(line: string): string | null {
    const match = LEVEL_TWO_HEADING.exec(line);
    const groups = match?.groups;
    if (groups === undefined) {
        return null;
    }
    // biome-ignore lint/complexity/useLiteralKeys: RegExpMatchArray.groups is an index signature requiring bracket access under noPropertyAccessFromIndexSignature
    const raw = groups['heading'];
    return raw === undefined ? null : raw.trim();
}

function isCountedHeading(headingText: string): boolean {
    return COUNTED_TODOS_HEADING.test(headingText) || COUNTED_FINAL_WAVE_HEADING.test(headingText);
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
