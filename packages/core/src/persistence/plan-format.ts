import { OmoPersistenceError } from './paths.js';
import { type PlanChecklist, parsePlanChecklistText } from './plan-store.js';

/**
 * Slug must be lowercase alphanumeric with single-hyphen separators.
 * Matches the `.omo/plans/{slug}.md` filename convention: no leading/trailing
 * hyphens, no consecutive hyphens, no uppercase, no underscores.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const TLDR_HEADING = '## TL;DR';
const TODOS_HEADING = '## TODOs';
const FINAL_WAVE_HEADING = '## Final Verification Wave';

export interface PlanSection {
    readonly heading: string;
    readonly body: string;
}

export interface PlanContent {
    readonly tldr: string;
    readonly todos: readonly string[];
    readonly finalWave: readonly string[];
}

export class PlanFormatError extends OmoPersistenceError {
    constructor(message: string, code: string, slug?: string, cause?: unknown) {
        super(message, code, slug, cause !== undefined ? { cause } : undefined);
        this.name = 'PlanFormatError';
    }
}

/**
 * Returns true when `slug` is a valid plan slug: lowercase alphanumeric
 * segments joined by single hyphens (`add-session-search`, `phase3`, `fix-42`).
 */
export function isValidPlanSlug(slug: string): boolean {
    return SLUG_PATTERN.test(slug);
}

/**
 * Throws `PlanFormatError` ({ code: 'plan_invalid_slug' }) when `slug` does not
 * satisfy `isValidPlanSlug`.
 */
export function assertValidPlanSlug(slug: string): void {
    if (!SLUG_PATTERN.test(slug)) {
        throw new PlanFormatError(
            `Invalid plan slug ${JSON.stringify(slug)}: expected lowercase alphanumeric with single-hyphen separators`,
            'plan_invalid_slug',
            slug,
        );
    }
}

/**
 * Format a plan as markdown with `# {slug}` title, `## TL;DR`,
 * `## TODOs` (unchecked checkboxes), and `## Final Verification Wave`
 * (unchecked checkboxes).
 *
 * The output is verified against `parsePlanChecklistText` before return so
 * the produced markdown is guaranteed to round-trip through the plan-store
 * checkbox parser. Every checkbox is rendered unchecked (`- [ ]`) because a
 * freshly written plan has not started execution yet.
 */
export function writePlan(slug: string, content: PlanContent): string {
    assertValidPlanSlug(slug);
    assertNonEmptyField(content.tldr, 'tldr');
    assertCheckboxItems(content.todos, 'todos');
    assertCheckboxItems(content.finalWave, 'finalWave');

    const markdown = formatPlanMarkdown(slug, content);
    verifyRoundTrip(markdown, content);
    return markdown;
}

function formatPlanMarkdown(slug: string, content: PlanContent): string {
    const title = `# ${slug}`;
    const sections: readonly PlanSection[] = [
        { heading: TLDR_HEADING, body: normalizeBlock(content.tldr) },
        { heading: TODOS_HEADING, body: formatChecklist(content.todos) },
        { heading: FINAL_WAVE_HEADING, body: formatChecklist(content.finalWave) },
    ];
    const rendered = sections.map((section) => `${section.heading}\n\n${section.body}`).join('\n\n');
    return `${title}\n\n${rendered}\n`;
}

function formatChecklist(items: readonly string[]): string {
    return items.map((item) => `- [ ] ${normalizeCheckboxText(item)}`).join('\n');
}

function normalizeBlock(text: string): string {
    return text.trim();
}

function normalizeCheckboxText(text: string): string {
    return text.replace(/\r?\n/gu, ' ').trim();
}

function assertNonEmptyField(value: string, field: string): void {
    if (value.trim().length === 0) {
        throw new PlanFormatError(`PlanContent.${field} must not be empty or whitespace-only`, 'plan_empty_field');
    }
}

function assertCheckboxItems(items: readonly string[], field: string): void {
    if (items.length === 0) {
        throw new PlanFormatError(`PlanContent.${field} must contain at least one item`, 'plan_empty_field');
    }
    for (const item of items) {
        if (item.trim().length === 0) {
            throw new PlanFormatError(
                `PlanContent.${field} contains an empty or whitespace-only checkbox item`,
                'plan_empty_field',
            );
        }
    }
}

function verifyRoundTrip(markdown: string, content: PlanContent): void {
    const checklist: PlanChecklist = parsePlanChecklistText(markdown);
    const expectedTotal = content.todos.length + content.finalWave.length;
    if (checklist.total !== expectedTotal) {
        throw new PlanFormatError(
            `writePlan round-trip verification failed: produced ${checklist.total} checkboxes, expected ${expectedTotal}`,
            'plan_round_trip_mismatch',
        );
    }
    if (checklist.completed > 0) {
        throw new PlanFormatError(
            `writePlan round-trip verification failed: ${checklist.completed} checkboxes parsed as checked (expected all unchecked)`,
            'plan_round_trip_mismatch',
        );
    }
}
