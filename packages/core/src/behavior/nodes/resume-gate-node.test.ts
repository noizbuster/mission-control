/**
 * Unit tests for deterministic resume-gate pure helpers + runner (plan T3).
 */
import type { AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import {
    classifyResumeGate,
    derivePlanSlug,
    detectHighAccuracyMarkers,
    parseDraftFrontmatter,
    rehydrateFromFrontmatter,
    runResumeGateNode,
} from './resume-gate-node';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-07-16T12:00:00.000Z';

function baseContext(
    blackboard: ReturnType<typeof createBlackboard>,
    workspaceRoot: string,
) {
    return {
        graphId: 'planner',
        now: () => NOW,
        blackboard,
        systemPromptEnv: { workspaceRoot },
    };
}

async function collect(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of signals) {
        out.push(signal);
    }
    return out;
}

function draftMarkdown(fields: {
    readonly status: string;
    readonly intent?: string;
    readonly review_required?: boolean;
    readonly body?: string;
}): string {
    const intent = fields.intent ?? '';
    const review = fields.review_required === true ? 'true' : 'false';
    return [
        '---',
        'slug: my-feature',
        `status: ${fields.status}`,
        `intent: ${intent.length === 0 ? '""' : intent}`,
        `review_required: ${review}`,
        'pending_action: ""',
        'approach: ""',
        '---',
        fields.body ?? '',
    ].join('\n');
}

describe('derivePlanSlug', () => {
    it('uses slug:<name> token when present', () => {
        // Given / When / Then
        expect(derivePlanSlug('Plan the auth rewrite slug:auth-rewrite please')).toBe('auth-rewrite');
    });

    it('kebabs goal text and caps at 80 chars', () => {
        // Given
        const goal = 'Add Session Search for Mission Control Dashboard!!!';
        // When
        const slug = derivePlanSlug(goal);
        // Then
        expect(slug).toBe('add-session-search-for-mission-control-dashboard');
        expect(slug.length).toBeLessThanOrEqual(80);
    });

    it('falls back to plan when goal has no alphanumeric content', () => {
        expect(derivePlanSlug('!!!')).toBe('plan');
    });
});

describe('detectHighAccuracyMarkers', () => {
    it('detects English and Korean markers case-insensitively', () => {
        expect(detectHighAccuracyMarkers('please use High Accuracy')).toBe(true);
        expect(detectHighAccuracyMarkers('ULTRA HIGH ACCURACY review')).toBe(true);
        expect(detectHighAccuracyMarkers('고정밀 계획')).toBe(true);
        expect(detectHighAccuracyMarkers('needs deep review')).toBe(true);
        expect(detectHighAccuracyMarkers('continue')).toBe(false);
    });
});

describe('parseDraftFrontmatter', () => {
    it('parses known fields and body', () => {
        // Given
        const raw = draftMarkdown({
            status: 'awaiting-approval',
            intent: 'clear',
            review_required: true,
            body: '# Draft body\n\ncontent',
        });
        // When
        const parsed = parseDraftFrontmatter(raw);
        // Then
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.frontmatter.status).toBe('awaiting-approval');
        expect(parsed.frontmatter.intent).toBe('clear');
        expect(parsed.frontmatter.review_required).toBe(true);
        expect(parsed.body.trim().startsWith('# Draft body')).toBe(true);
    });

    it('fails closed on corrupt frontmatter', () => {
        expect(parseDraftFrontmatter('not a draft').ok).toBe(false);
        expect(parseDraftFrontmatter('---\nstatus: not-a-status\n---\n').ok).toBe(false);
        expect(parseDraftFrontmatter('---\nno close').ok).toBe(false);
    });
});

describe('classifyResumeGate', () => {
    it('returns resume_approval when status is awaiting-approval', () => {
        expect(classifyResumeGate('awaiting-approval', false)).toBe('resume_approval');
        expect(classifyResumeGate('awaiting-approval', true)).toBe('resume_approval');
    });

    it('returns resume_drafting when drafting with non-empty body', () => {
        expect(classifyResumeGate('drafting', true)).toBe('resume_drafting');
    });

    it('returns fresh for drafting with empty body, approved-writing, or missing status', () => {
        expect(classifyResumeGate('drafting', false)).toBe('fresh');
        expect(classifyResumeGate('approved-writing', true)).toBe('fresh');
        expect(classifyResumeGate(undefined, true)).toBe('fresh');
    });
});

describe('rehydrateFromFrontmatter', () => {
    it('restores intent and review_required on resume when markers absent', () => {
        // Given / When
        const out = rehydrateFromFrontmatter({
            gate: 'resume_approval',
            markersPresent: false,
            frontmatter: { intent: 'clear', review_required: true },
        });
        // Then
        expect(out.intent).toBe('clear');
        expect(out.review_required).toBe(true);
    });

    it('does not override review_required from frontmatter when markers present', () => {
        const out = rehydrateFromFrontmatter({
            gate: 'resume_drafting',
            markersPresent: true,
            frontmatter: { intent: 'unclear', review_required: false },
        });
        expect(out.intent).toBe('unclear');
        expect(out.review_required).toBeUndefined();
    });

    it('does not rehydrate review_required on fresh path', () => {
        const out = rehydrateFromFrontmatter({
            gate: 'fresh',
            markersPresent: false,
            frontmatter: { intent: 'clear', review_required: true },
        });
        expect(out.intent).toBe('clear');
        expect(out.review_required).toBeUndefined();
    });
});

describe('runResumeGateNode', () => {
    let workspaceRoot: string;

    afterEach(async () => {
        if (workspaceRoot !== undefined) {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    async function setupWorkspace(): Promise<string> {
        workspaceRoot = await mkdtemp(join(tmpdir(), 'resume-gate-'));
        await mkdir(join(workspaceRoot, '.omo', 'drafts'), { recursive: true });
        return workspaceRoot;
    }

    it('routes resume_approval when draft status is awaiting-approval', async () => {
        // Given
        const root = await setupWorkspace();
        await writeFile(
            join(root, '.omo', 'drafts', 'my-feature.md'),
            draftMarkdown({
                status: 'awaiting-approval',
                intent: 'clear',
                review_required: true,
                body: '## Draft\n\nready for approval',
            }),
            'utf8',
        );
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'continue slug:my-feature' }]);

        // When
        const signals = await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('resume_approval');
        expect(blackboard.get('plan.slug')).toBe('my-feature');
        expect(blackboard.get('intent')).toBe('clear');
        expect(blackboard.get('review_required')).toBe(true);
        expect(signals.some((s) => s.type === 'success')).toBe(true);
    });

    it('routes resume_drafting when drafting with non-empty body', async () => {
        // Given
        const root = await setupWorkspace();
        await writeFile(
            join(root, '.omo', 'drafts', 'my-feature.md'),
            draftMarkdown({
                status: 'drafting',
                intent: 'unclear',
                review_required: false,
                body: '## Work in progress\n\npartial draft',
            }),
            'utf8',
        );
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'continue slug:my-feature' }]);

        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('resume_drafting');
        expect(blackboard.get('intent')).toBe('unclear');
    });

    it('routes fresh when no draft exists', async () => {
        // Given
        const root = await setupWorkspace();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'Plan a new feature for search' }]);

        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('fresh');
        expect(typeof blackboard.get('plan.slug')).toBe('string');
        expect(blackboard.get('review_required')).toBe(false);
    });

    it('sets review_required true from markers on fresh path', async () => {
        // Given
        const root = await setupWorkspace();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'Plan X with high accuracy' }]);

        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('fresh');
        expect(blackboard.get('review_required')).toBe(true);
        expect(blackboard.get('interview.force')).toBe(false);
    });

    it('sets interview.force true from interview force markers', async () => {
        // Given
        const root = await setupWorkspace();
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'Plan auth and interview me about tradeoffs' }]);

        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('fresh');
        expect(blackboard.get('interview.force')).toBe(true);
    });

    it('keeps frontmatter review_required on resume when user only says continue', async () => {
        // Given
        const root = await setupWorkspace();
        await writeFile(
            join(root, '.omo', 'drafts', 'my-feature.md'),
            draftMarkdown({
                status: 'awaiting-approval',
                intent: 'clear',
                review_required: true,
                body: 'body',
            }),
            'utf8',
        );
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'continue slug:my-feature' }]);

        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then — frontmatter wins over marker-less continue
        expect(blackboard.get('resume_gate')).toBe('resume_approval');
        expect(blackboard.get('review_required')).toBe(true);
    });

    it('treats corrupt frontmatter as fresh and emits diagnostic', async () => {
        // Given
        const root = await setupWorkspace();
        await writeFile(join(root, '.omo', 'drafts', 'my-feature.md'), 'not valid frontmatter', 'utf8');
        const blackboard = createBlackboard();
        blackboard.appendMessages([{ role: 'user', content: 'continue slug:my-feature' }]);

        // When
        const signals = await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );

        // Then
        expect(blackboard.get('resume_gate')).toBe('fresh');
        const diagnostic = signals.find(
            (s): s is Extract<AbgSignal, { type: 'emit' }> =>
                s.type === 'emit' && s.event.type === 'resume_gate.diagnostic',
        );
        expect(diagnostic).toBeDefined();
        expect((diagnostic?.event.payload as { code?: string } | undefined)?.code).toBe('corrupt_frontmatter');
    });

    it('routes fresh when plan.slug is missing and goal yields no draft', async () => {
        // Given
        const root = await setupWorkspace();
        const blackboard = createBlackboard();
        // no user messages → fallback slug "plan", no draft
        // When
        await collect(
            runResumeGateNode({ id: 'resume-gate', kind: 'llm', implementation: 'resume-gate' }, baseContext(blackboard, root)),
        );
        // Then
        expect(blackboard.get('resume_gate')).toBe('fresh');
        expect(blackboard.get('plan.slug')).toBe('plan');
    });
});
