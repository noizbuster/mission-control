import { afterEach, describe, expect, it } from 'vitest';
import {
    DUAL_REVIEW_RECEIPTS_HEADING,
    PLANNER_SCAFFOLD_HEADERS,
    PlanScaffoldError,
    type ScaffoldPlanFilesResult,
    appendDualReviewReceipts,
    scaffoldPlanFiles,
    writeDraftFrontmatter,
} from './plan-scaffold';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'plan-scaffold-'));
    tempRoots.push(root);
    return root;
}

function draftPath(root: string, slug: string): string {
    return join(root, '.omo', 'drafts', `${slug}.md`);
}

function planPath(root: string, slug: string): string {
    return join(root, '.omo', 'plans', `${slug}.md`);
}

describe('PLANNER_SCAFFOLD_HEADERS', () => {
    it('keeps Title Case headers in locked order', () => {
        expect(PLANNER_SCAFFOLD_HEADERS).toEqual([
            '# <slug> - Work Plan',
            '## TL;DR (For humans)',
            '## Scope',
            '## Verification Strategy',
            '## Execution Strategy',
            '## Todos',
            '## Final Verification Wave',
            '## Commit Strategy',
            '## Success Criteria',
        ]);
    });
});

describe('scaffoldPlanFiles', () => {
    it('creates draft frontmatter stub and plan skeleton under .omo/', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'demo-plan';

        // When
        const result = await scaffoldPlanFiles(root, slug);

        // Then
        expect(result).toMatchObject({
            created: true,
            reason: 'created',
            draftPath: draftPath(root, slug),
            planPath: planPath(root, slug),
        } satisfies Partial<ScaffoldPlanFilesResult>);
        expect(existsSync(result.draftPath)).toBe(true);
        expect(existsSync(result.planPath)).toBe(true);

        const draft = readFileSync(result.draftPath, 'utf8');
        expect(draft.startsWith('---\n')).toBe(true);
        expect(draft).toContain('slug: demo-plan');
        expect(draft).toContain('status: drafting');
        expect(draft).toContain('intent:');
        expect(draft).toContain('review_required:');
        expect(draft).toContain('pending_action:');
        expect(draft).toContain('approach:');

        const plan = readFileSync(result.planPath, 'utf8');
        expect(plan.startsWith('# demo-plan - Work Plan\n')).toBe(true);
        expect(plan).toMatch(/^Status:\s/m);
        for (const header of PLANNER_SCAFFOLD_HEADERS) {
            if (header.startsWith('# ')) {
                expect(plan).toContain(header.replace('<slug>', slug));
            } else {
                expect(plan).toContain(header);
            }
        }
    });

    it('is a no-op when the plan file already has scaffold markers', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'existing-plan';
        const first = await scaffoldPlanFiles(root, slug);
        const originalDraft = readFileSync(first.draftPath, 'utf8');
        const originalPlan = readFileSync(first.planPath, 'utf8');
        const marker = '\n<!-- mutated after first scaffold -->\n';
        writeFileSync(first.draftPath, `${originalDraft}${marker}`, 'utf8');
        writeFileSync(first.planPath, `${originalPlan}${marker}`, 'utf8');

        // When
        const second = await scaffoldPlanFiles(root, slug);

        // Then
        expect(second).toMatchObject({
            created: false,
            reason: 'already_scaffolded',
            draftPath: first.draftPath,
            planPath: first.planPath,
        });
        expect(readFileSync(first.draftPath, 'utf8')).toBe(`${originalDraft}${marker}`);
        expect(readFileSync(first.planPath, 'utf8')).toBe(`${originalPlan}${marker}`);
    });

    it('rejects invalid slugs including path escape attempts', async () => {
        // Given
        const root = makeTempRoot();
        const invalidSlugs = ['', '../escape', '/abs/path', 'CamelCase', 'with_underscore', 'double--hyphen'];

        // When / Then
        for (const slug of invalidSlugs) {
            await expect(scaffoldPlanFiles(root, slug)).rejects.toBeInstanceOf(PlanScaffoldError);
            await expect(scaffoldPlanFiles(root, slug)).rejects.toMatchObject({
                code: 'plan_scaffold_invalid_slug',
            });
            expect(existsSync(join(root, '.omo', 'plans'))).toBe(false);
            expect(existsSync(join(root, '.omo', 'drafts'))).toBe(false);
        }
    });

    it('rejects workspace roots that would escape via non-directory targets', async () => {
        // Given: a file where a directory is expected for .omo nesting
        const root = makeTempRoot();
        const fileAsRoot = join(root, 'not-a-dir');
        writeFileSync(fileAsRoot, 'nope', 'utf8');

        // When / Then
        await expect(scaffoldPlanFiles(fileAsRoot, 'safe-slug')).rejects.toBeInstanceOf(PlanScaffoldError);
        await expect(scaffoldPlanFiles(fileAsRoot, 'safe-slug')).rejects.toMatchObject({
            code: 'plan_scaffold_path_escape',
        });
    });

    it('accepts optional frontmatter overrides without rewriting scaffolded plans', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'override-plan';

        // When
        const result = await scaffoldPlanFiles(root, slug, {
            status: 'awaiting-approval',
            intent: 'clear',
            reviewRequired: true,
            pendingAction: 'wait-for-user',
            approach: 'deepen planner graph',
        });

        // Then
        const draft = readFileSync(result.draftPath, 'utf8');
        expect(draft).toContain('status: awaiting-approval');
        expect(draft).toContain('intent: clear');
        expect(draft).toContain('review_required: true');
        expect(draft).toContain('pending_action: wait-for-user');
        expect(draft).toContain('approach: "deepen planner graph"');

        const second = await scaffoldPlanFiles(root, slug, {
            status: 'drafting',
            intent: 'unclear',
        });
        expect(second.created).toBe(false);
        expect(readFileSync(result.draftPath, 'utf8')).toBe(draft);
    });

    it('creates missing .omo/plans and .omo/drafts directories', async () => {
        // Given
        const root = makeTempRoot();

        // When
        await scaffoldPlanFiles(root, 'mkdir-plan');

        // Then
        expect(existsSync(join(root, '.omo', 'plans'))).toBe(true);
        expect(existsSync(join(root, '.omo', 'drafts'))).toBe(true);
    });

    it('writeDraftFrontmatter creates drafting frontmatter and preserves body on update', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'frontmatter-write';

        // When
        const first = await writeDraftFrontmatter(root, slug, {
            status: 'drafting',
            intent: 'clear',
            reviewRequired: false,
        });
        writeFileSync(first.draftPath, `${readFileSync(first.draftPath, 'utf8')}# Draft body\n`, 'utf8');
        const second = await writeDraftFrontmatter(root, slug, {
            status: 'awaiting-approval',
            intent: 'clear',
            reviewRequired: true,
        });

        // Then
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        const draft = readFileSync(second.draftPath, 'utf8');
        expect(draft).toContain('status: awaiting-approval');
        expect(draft).toContain('intent: clear');
        expect(draft).toContain('review_required: true');
        expect(draft).toContain('# Draft body');
    });

    it('appendDualReviewReceipts adds a Dual review receipts section with agent verdicts', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'receipts-plan';
        await writeDraftFrontmatter(root, slug, { status: 'drafting', intent: 'clear' });

        // When
        const result = await appendDualReviewReceipts(root, slug, {
            reviewer: 'REJECT',
            oracle: 'APPROVE',
            verdict: 'REJECT',
            attempt: 1,
        });

        // Then
        expect(result.appended).toBe(true);
        const draft = readFileSync(result.draftPath, 'utf8');
        expect(draft).toContain(DUAL_REVIEW_RECEIPTS_HEADING);
        expect(draft).toContain('attempt 1: reviewer=REJECT, oracle=APPROVE, verdict=REJECT');
    });

    it('detects scaffold markers on an existing hand-authored plan with Status line', async () => {
        // Given
        const root = makeTempRoot();
        const slug = 'hand-authored';
        mkdirSync(join(root, '.omo', 'plans'), { recursive: true });
        mkdirSync(join(root, '.omo', 'drafts'), { recursive: true });
        const existingPlan = [
            `# ${slug} - Work Plan`,
            '',
            'Status: Approved',
            '',
            '## TL;DR (For humans)',
            '',
            'Existing body.',
            '',
            '## Scope',
            '',
            '## Verification Strategy',
            '',
            '## Execution Strategy',
            '',
            '## Todos',
            '',
            '## Final Verification Wave',
            '',
            '## Commit Strategy',
            '',
            '## Success Criteria',
            '',
        ].join('\n');
        writeFileSync(planPath(root, slug), existingPlan, 'utf8');
        writeFileSync(draftPath(root, slug), '---\nslug: hand-authored\nstatus: drafting\n---\nbody\n', 'utf8');
        const beforeDraft = readFileSync(draftPath(root, slug), 'utf8');

        // When
        const result = await scaffoldPlanFiles(root, slug);

        // Then
        expect(result.created).toBe(false);
        expect(result.reason).toBe('already_scaffolded');
        expect(readFileSync(planPath(root, slug), 'utf8')).toBe(existingPlan);
        expect(readFileSync(draftPath(root, slug), 'utf8')).toBe(beforeDraft);
    });
});
